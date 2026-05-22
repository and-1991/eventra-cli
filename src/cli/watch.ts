import chokidar from "chokidar";
import chalk from "chalk";
import fs from "fs/promises";
import fg from "fast-glob";
import path from "path";

import { loadConfig } from "../config/config";
import { EVENTRA_SDK_SHIM } from "../analysis/sdk/eventraSdk";
import { EventraEngine } from "../core/EventraEngine";
import { persistScanResults } from "../core/scanResults";

const SDK_TYPES_FILE = "__eventra_sdk_types__.d.ts";
import { processFile } from "../filesystem/processFile";
import { getVirtualFile } from "../filesystem/getVirtualFile";

interface CachedFile {
  readonly content: string;
  readonly dependencies: readonly string[];
}

export async function watch(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    return;
  }

  console.log(chalk.blue("Watching...\n"));
  const engine = new EventraEngine(process.cwd());
  const fileDeps = new Map<string, Set<string>>();
  const cache = new Map<string, CachedFile>();
  const watchedDeps = new Set<string>();
  const trackedFiles = new Set<string>();

  const normalize = (file: string): string => {
    return path.resolve(file).replace(/\\/g, "/");
  };

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
    absolute: true,
  });

  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES_FILE, EVENTRA_SDK_SHIM);
  for (const file of files) {
    try {
      const abs = normalize(file);
      const raw = await fs.readFile(abs, "utf-8");
      const parsed = await processFile(abs, raw);
      cache.set(abs, parsed);
      trackedFiles.add(abs);
      await engine.preloadFile(getVirtualFile(abs), parsed.content);
      fileDeps.set(
        abs,
        new Set(
          parsed.dependencies
            .filter((dep) => dep.startsWith(".") || dep.startsWith("/"))
            .map((dep) => normalize(path.resolve(path.dirname(abs), dep))),
        ),
      );
    } catch {
      // ignore invalid files
    }
  }
  engine.endPreload();

  await engine.runFullAnalysis(
    [SDK_TYPES_FILE, ...trackedFiles].map((f) => getVirtualFile(f)),
    config,
  );
  await persistScanResults(config, engine);

  const initialEvents = engine.getAllEvents();
  const initialWrappers = engine.getAllFunctionWrappers();
  console.log(
    chalk.gray(`Initial: ${initialEvents.length} events, ${initialWrappers.length} wrappers\n`),
  );

  const watcher = chokidar.watch([...trackedFiles, ...watchedDeps], { ignoreInitial: true });
  const queue = new Map<string, boolean>();
  let timer: NodeJS.Timeout | null = null;

  const run = async (): Promise<void> => {
    const batch = [...queue.keys()];
    queue.clear();
    for (const file of batch) {
      try {
        const raw = await fs.readFile(file, "utf-8");
        const parsed = await processFile(file, raw);
        cache.set(file, parsed);
        trackedFiles.add(file);
        await engine.updateFile(getVirtualFile(file), parsed.content, config);

        const abs = normalize(file);
        const prevDeps = fileDeps.get(abs) ?? new Set();
        const nextDeps = new Set(
          parsed.dependencies
            .filter((dep) => dep.startsWith(".") || dep.startsWith("/"))
            .map((dep) => normalize(path.resolve(path.dirname(abs), dep))),
        );

        for (const dep of nextDeps) {
          if (prevDeps.has(dep)) continue;
          watcher.add(dep);
          watchedDeps.add(dep);
        }
        for (const dep of prevDeps) {
          if (nextDeps.has(dep)) continue;
          watcher.unwatch(dep);
          watchedDeps.delete(dep);
        }
        fileDeps.set(abs, nextDeps);
      } catch {
        console.log(chalk.gray(`skip: ${file}`));
      }
    }

    await persistScanResults(config, engine);
    console.log(
      chalk.green(
        `Updated: ${engine.getAllEvents().length} events, ${engine.getAllFunctionWrappers().length} wrappers`,
      ),
    );
  };

  const schedule = (file: string): void => {
    const abs = normalize(file);
    queue.set(abs, true);
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 200);
  };

  watcher
    .on("change", schedule)
    .on("add", schedule)
    .on("unlink", async (file): Promise<void> => {
      const abs = normalize(file);
      trackedFiles.delete(abs);
      await engine.removeFile(getVirtualFile(abs), config);
      await persistScanResults(config, engine);
      console.log(
        chalk.red(
          `Removed → ${engine.getAllEvents().length} events, ${engine.getAllFunctionWrappers().length} wrappers`,
        ),
      );
    });

  process.on("SIGINT", async (): Promise<void> => {
    await watcher.close();
    process.exit(0);
  });
}
