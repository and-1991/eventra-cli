import chokidar from "chokidar";
import chalk from "chalk";
import fs from "fs/promises";
import fg from "fast-glob";
import path from "path";

import {loadConfig, saveConfig} from "../config/config";
import {EventraEngine} from "../core/EventraEngine";
import {processFile} from "../filesystem/processFile";
import {getVirtualFile} from "../filesystem/getVirtualFile";

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
  const engine = new EventraEngine(process.cwd(),);
  const fileDeps = new Map<string, Set<string>>();
  const cache = new Map<string, CachedFile>();
  const watchedDeps = new Set<string>();
  const normalize = (file: string): string => {
    return path.resolve(file).replace(/\\/g, "/");
  };
  // INITIAL LOAD
  const files = await fg(config.sync.include,
    {
      ignore: config.sync.exclude,
      absolute: true,
    },
  );
  engine.beginPreload();
  for (const file of files) {
    try {
      const abs = normalize(file);
      const raw = await fs.readFile(abs, "utf-8");
      const parsed = await processFile(abs, raw);
      cache.set(abs, parsed);
      await engine.preloadFile(getVirtualFile(abs), parsed.content);
      await engine.updateFile(getVirtualFile(abs), parsed.content, config);
      fileDeps.set(abs, new Set(parsed.dependencies.map(dep => normalize(dep))));
    } catch {
      // ignore invalid files
    }
  }
  engine.endPreload();
  const initialEvents = engine.getAllEvents().sort();
  await saveConfig({
    ...config,
    events: initialEvents,
  });
  console.log(chalk.gray(`Initial: ${initialEvents.length}\n`));
  // WATCHER
  const watcher = chokidar.watch([...files.map(normalize), ...watchedDeps], {ignoreInitial: true});
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
        await engine.updateFile(getVirtualFile(file), parsed.content, config);
        // dependency diff
        const abs = normalize(file);
        const prevDeps = fileDeps.get(abs) ?? new Set();
        const nextDeps = new Set(parsed.dependencies.map(dep => normalize(dep)));
        // add deps
        for (const dep of nextDeps) {
          if (prevDeps.has(dep)) {
            continue;
          }
          watcher.add(dep);
          watchedDeps.add(dep);
        }
        // remove deps
        for (const dep of prevDeps) {
          if (nextDeps.has(dep)) {
            continue;
          }
          watcher.unwatch(dep);
          watchedDeps.delete(dep);
        }
        fileDeps.set(abs, nextDeps);
      } catch {
        console.log(chalk.gray(`skip: ${file}`));
      }
    }
    const nextEvents = engine.getAllEvents().sort();
    await saveConfig({
      ...config,
      events: nextEvents,
    });
    console.log(chalk.green(`Updated: ${nextEvents.length}`));
  };

  const schedule = (file: string): void => {
    const abs = normalize(file);
    queue.set(abs, true);
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(run, 200);
  };

  watcher
    .on("change", schedule)
    .on("add", schedule)
    .on("unlink", async (file): Promise<void> => {
        const abs = normalize(file);
        await engine.removeFile(getVirtualFile(abs), config);
        const nextEvents = engine.getAllEvents().sort();
        await saveConfig({
          ...config,
          events: nextEvents,
        });
        console.log(chalk.red(`Removed → ${nextEvents.length}`),
        );
      },
    );
  process.on("SIGINT", async (): Promise<void> => {
      await watcher.close();
      process.exit(0);
    },
  );
}
