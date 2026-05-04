import chokidar from "chokidar";
import chalk from "chalk";
import fs from "fs/promises";
import fg from "fast-glob";
import path from "path";

import { loadConfig, saveConfig } from "../utils/config";
import { EventraEngine } from "../engine/engine";
import { processFile } from "../utils/processFile";

type QueueItem = {
  real: string;
  virtual: string;
};

// stabile virtual mapping
function getVirtualFile(file: string) {
  return /\.(vue|svelte|astro|html)$/i.test(file)
    ? file + ".tsx"
    : file;
}

export async function watch() {
  const config = await loadConfig();
  if (!config) return;

  console.log(chalk.blue("Watching...\n"));

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
  });

  const engine = new EventraEngine(process.cwd());

  const watchedDeps = new Set<string>();

  // INITIAL LOAD
  for (const file of files) {
    try {
      const abs = path.resolve(file);
      const raw = await fs.readFile(abs, "utf-8");

      const { content, deps } = processFile(abs, raw);
      const virtual = getVirtualFile(abs);

      engine.scanFile(virtual, content, config);

      // deps
      for (const dep of deps) {
        watchedDeps.add(path.resolve(dep));
      }

    } catch {
      console.log(chalk.gray(`skip: ${file}`));
    }
  }

  config.events = engine.getAllEvents().sort();
  await saveConfig(config);

  console.log(
    chalk.gray(`Initial: ${config.events.length} events\n`)
  );

  // QUEUE
  let locked = false;
  let queued = new Map<string, QueueItem>();
  let timer: NodeJS.Timeout | null = null;

  const run = async () => {
    if (locked) {
      timer = setTimeout(run, 100);
      return;
    }

    locked = true;

    const batch = [...queued.values()];
    queued.clear();

    for (const item of batch) {
      try {
        const raw = await fs.readFile(item.real, "utf-8");

        const { content, deps } = processFile(item.real, raw);

        engine.updateFile(item.virtual, content, config);

        // DEPS
        for (const dep of deps) {
          const absDep = path.resolve(dep);

          if (!watchedDeps.has(absDep)) {
            watcher.add(absDep);
            watchedDeps.add(absDep);
          }

          try {
            const depRaw = await fs.readFile(absDep, "utf-8");
            const { content: depContent } = processFile(absDep, depRaw);

            const depVirtual = getVirtualFile(absDep);

            engine.updateFile(depVirtual, depContent, config);
          } catch {}
        }

      } catch {
        console.log(chalk.gray(`skip: ${item.real}`));
      }
    }

    // EVENTS DIFF
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

    queued.set(abs, { real: abs, virtual });

    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 300);
  };

  // WATCHER
  const watcher = chokidar.watch(config.sync.include, {
    ignored: config.sync.exclude,
    ignoreInitial: true,
  });

  watcher
    .on("add", schedule)
    .on("change", schedule)
    .on("unlink", async (file) => {
      const abs = path.resolve(file);

      console.log(chalk.gray(`remove: ${file}`));

      const virtual = getVirtualFile(abs);

      engine.removeFile(virtual, config);

      watchedDeps.delete(abs);

      const next = engine.getAllEvents();

      config.events = next.sort();
      await saveConfig(config);

      console.log(
        chalk.gray(`Total: ${config.events.length} events\n`)
      );
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
