import chokidar from "chokidar";
import chalk from "chalk";
import fs from "fs/promises";
import fg from "fast-glob";
import path from "path";

import { loadConfig, saveConfig } from "../utils/config";
import { EventraEngine } from "../engine/engine";
import { processFile } from "../utils/processFile";
import { getVirtualFile } from "../utils/getVirtualFile";

type QueueItem = {
  real: string;
  virtual: string;
};

export async function watch() {
  const config = await loadConfig();
  if (!config) return;

  console.log(chalk.blue("Watching...\n"));

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
    absolute: true,
  });

  const engine = new EventraEngine(process.cwd());
  const watchedDeps = new Set<string>();
  const cache = new Map<
    string,
    { content: string; deps: string[] }
  >();

  const toScan = new Set<string>();

  // COLLECT + CACHE
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");

      if (raw.length > 2_000_000) continue; // safeguard

      const parsed = processFile(file, raw);

      cache.set(file, parsed);
      toScan.add(file);

      for (const dep of parsed.deps) {
        const absDep = path.resolve(dep);
        toScan.add(absDep);
      }

    } catch {
      console.log(chalk.gray(`skip: ${file}`));
    }
  }

  // PRELOAD (TS PROGRAM)
  for (const file of toScan) {
    try {
      let parsed = cache.get(file);

      if (!parsed) {
        const raw = await fs.readFile(file, "utf-8");
        parsed = processFile(file, raw);
      }

      const virtual = getVirtualFile(file);

      engine.preloadFile?.(virtual, parsed.content);

    } catch {}
  }

  // INITIAL SCAN
  for (const file of toScan) {
    try {
      let parsed = cache.get(file);

      if (!parsed) {
        const raw = await fs.readFile(file, "utf-8");
        parsed = processFile(file, raw);
      }

      const virtual = getVirtualFile(file);

      engine.scanFile(virtual, parsed.content, config);

      for (const dep of parsed.deps) {
        watchedDeps.add(path.resolve(dep));
      }

    } catch {}
  }

  config.events = engine.getAllEvents().sort();
  await saveConfig(config);

  console.log(
    chalk.gray(`Initial: ${config.events.length} events\n`)
  );

  // QUEUE
  let locked = false;
  const queued = new Map<string, QueueItem>();
  let timer: NodeJS.Timeout | null = null;

  const run = async () => {
    if (locked) return;
    locked = true;

    const batch = [...queued.values()];
    queued.clear();

    for (const item of batch) {
      try {
        const raw = await fs.readFile(item.real, "utf-8");

        if (raw.length > 2_000_000) continue;

        const parsed = processFile(item.real, raw);

        cache.set(item.real, parsed);

        engine.updateFile(item.virtual, parsed.content, config);

        // DEPS
        for (const dep of parsed.deps) {
          const absDep = path.resolve(dep);

          if (!watchedDeps.has(absDep)) {
            watcher.add(absDep);
            watchedDeps.add(absDep);
          }

          try {
            const depRaw = await fs.readFile(absDep, "utf-8");
            const depParsed = processFile(absDep, depRaw);

            cache.set(absDep, depParsed);

            const depVirtual = getVirtualFile(absDep);

            engine.updateFile(depVirtual, depParsed.content, config);
          } catch {}
        }

      } catch {
        console.log(chalk.gray(`skip: ${item.real}`));
      }
    }

    // DIFF EVENTS
    const next = engine.getAllEvents();

    const added = next.filter(e => !config.events.includes(e));
    const removed = config.events.filter(e => !next.includes(e));

    if (added.length || removed.length) {
      added.forEach(e => console.log(chalk.green(`+ ${e}`)));
      removed.forEach(e => console.log(chalk.red(`- ${e}`)));

      config.events = next.sort();
      await saveConfig(config);

      console.log(
        chalk.gray(`Total: ${config.events.length} events\n`)
      );
    }

    locked = false;
  };

  // SCHEDULER
  const schedule = (file: string) => {
    const abs = path.resolve(file);
    const virtual = getVirtualFile(abs);

    console.log(chalk.gray(`change: ${file}`));

    queued.set(abs, { real: abs, virtual });

    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 250);
  };

  // WATCHER
  const watcher = chokidar.watch(config.sync.include, {
    ignored: config.sync.exclude,
    ignoreInitial: true,
    persistent: true,
  });

  watcher
    .on("add", schedule)
    .on("change", schedule)
    .on("unlink", async (file) => {
      const abs = path.resolve(file);

      console.log(chalk.gray(`remove: ${file}`));

      const virtual = getVirtualFile(abs);

      engine.removeFile(virtual, config);

      watcher.unwatch(abs);
      watchedDeps.delete(abs);

      const next = engine.getAllEvents();

      config.events = next.sort();
      await saveConfig(config);

      console.log(
        chalk.gray(`Total: ${config.events.length} events\n`)
      );
    })
    .on("error", (err) => {
      console.error(chalk.red("Watcher error:"), err);
    });

  // WATCH DEPS
  for (const dep of watchedDeps) {
    watcher.add(dep);
  }

  // EXIT
  process.on("SIGINT", async () => {
    console.log(chalk.yellow("\nStopping watcher..."));
    await watcher.close();
    process.exit(0);
  });
}
