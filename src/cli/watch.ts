import chokidar from "chokidar";
import chalk from "chalk";
import fs from "fs/promises";
import fg from "fast-glob";
import path from "path";

import { loadConfig } from "../config/config";
import { EVENTRA_SDK_SHIM } from "../analysis/sdk/eventraSdk";
import { EventraEngine } from "../core/EventraEngine";
import { persistScanResults } from "../core/scanResults";
import { createPluginRegistry } from "../plugin/loadPlugins";

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
  const plugins = await createPluginRegistry(config);
  const include = [...config.sync.include, ...plugins.getIncludePatterns()];
  const engine = new EventraEngine(process.cwd(), plugins);
  const fileDeps = new Map<string, Set<string>>();
  const cache = new Map<string, CachedFile>();
  const watchedDeps = new Set<string>();
  const trackedFiles = new Set<string>();
  const sourceFiles = new Set<string>();

  const normalize = (file: string): string => {
    return path.resolve(file).replace(/\\/g, "/");
  };

  const files = await fg(include, {
    ignore: config.sync.exclude,
    absolute: true,
  });

  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES_FILE, EVENTRA_SDK_SHIM);
  for (const file of files) {
    try {
      const abs = normalize(file);
      sourceFiles.add(abs);
      const raw = await fs.readFile(abs, "utf-8");
      const virtualFiles = await plugins.preprocessFile({ fileName: abs, content: raw });

      for (const virtualFile of virtualFiles) {
        const scanPath = normalize(virtualFile.fileName);
        const parsed = await processFile(scanPath, virtualFile.content);
        cache.set(scanPath, parsed);
        trackedFiles.add(scanPath);
        await engine.preloadFile(getVirtualFile(scanPath), virtualFile.content);
        fileDeps.set(
          scanPath,
          new Set(
            parsed.dependencies
              .filter((dep) => dep.startsWith(".") || dep.startsWith("/"))
              .map((dep) => normalize(path.resolve(path.dirname(scanPath), dep))),
          ),
        );
      }
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

  const watcher = chokidar.watch([...sourceFiles, ...watchedDeps], { ignoreInitial: true });
  const queue = new Map<string, boolean>();
  let timer: NodeJS.Timeout | null = null;

  const run = async (): Promise<void> => {
    const batch = [...queue.keys()];
    queue.clear();
    for (const file of batch) {
      try {
        const raw = await fs.readFile(file, "utf-8");
        const virtualFiles = await plugins.preprocessFile({ fileName: file, content: raw });

        for (const virtualFile of virtualFiles) {
          const scanPath = normalize(virtualFile.fileName);
          const parsed = await processFile(scanPath, virtualFile.content);
          cache.set(scanPath, parsed);
          trackedFiles.add(scanPath);
          await engine.updateFile(getVirtualFile(scanPath), virtualFile.content, config);

          const prevDeps = fileDeps.get(scanPath) ?? new Set();
          const nextDeps = new Set(
            parsed.dependencies
              .filter((dep) => dep.startsWith(".") || dep.startsWith("/"))
              .map((dep) => normalize(path.resolve(path.dirname(scanPath), dep))),
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
          fileDeps.set(scanPath, nextDeps);
        }
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
      sourceFiles.delete(abs);
      const virtualPaths = plugins.getVirtualPathsForSource(abs);
      for (const virtualPath of virtualPaths) {
        trackedFiles.delete(virtualPath);
        await engine.removeFile(getVirtualFile(virtualPath), config);
      }
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
