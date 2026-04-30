import chokidar from "chokidar";
import chalk from "chalk";
import fs from "fs/promises";
import fg from "fast-glob";
import path from "path";

import { loadConfig, saveConfig } from "../utils/config";
import { EventraEngine } from "../engine/engine";
import { processFile } from "../utils/processFile";

export async function watch() {
  const config = await loadConfig();
  if (!config) return;

  console.log(chalk.blue("Watching...\n"));

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
  });

  const engine = new EventraEngine(process.cwd());

  const fileCache: { file: string; content: string }[] = [];

  // PRELOAD TS
  for (const file of files) {
    try {
      const abs = path.resolve(file);
      const raw = await fs.readFile(abs, "utf-8");
      const { content, virtualFile } = processFile(abs, raw);
      fileCache.push({ file: virtualFile, content });
    } catch {
      console.log(chalk.gray(`skip: ${file}`));
    }
  }

  // INITIAL SCAN
  for (const { file, content } of fileCache) {
    engine.scanFile(file, content, config);
  }

  config.events = engine.getAllEvents().sort();
  await saveConfig(config);

  console.log(
    chalk.gray(`Initial: ${config.events.length} events\n`)
  );

  let locked = false;
  let queued = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const run = async () => {
    if (locked) return;
    locked = true;

    const batch = [...queued];
    queued.clear();

    for (const file of batch) {
      try {
        const raw = await fs.readFile(file, "utf-8");
        const { content, virtualFile } = processFile(file, raw);

        engine.updateFile(virtualFile, content, config);

      } catch {
        console.log(chalk.gray(`skip: ${file}`));
      }
    }

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

  const schedule = (file: string) => {
    queued.add(path.resolve(file));

    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 200);
  };

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

      const { virtualFile } = processFile(abs, "");

      engine.removeFile(virtualFile, config);

      const next = engine.getAllEvents();

      config.events = next.sort();
      await saveConfig(config);

      console.log(
        chalk.gray(`Total: ${config.events.length} events\n`)
      );
    });

  process.on("SIGINT", async () => {
    console.log(chalk.yellow("\nStopping watcher..."));
    await watcher.close();
    process.exit(0);
  });
}
