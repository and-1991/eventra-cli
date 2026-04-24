import chokidar from "chokidar";
import chalk from "chalk";
import fs from "fs/promises";
import fg from "fast-glob";

import { loadConfig, saveConfig } from "../utils/config";
import { EventraEngine } from "../engine/engine";

import { detectParser } from "../utils/parsers/router";
import { parseVue } from "../utils/parsers/vue";
import { parseSvelte } from "../utils/parsers/svelte";
import { parseAstro } from "../utils/parsers/astro";

// PREPROCESS (CONTENT)
function preprocess(file: string, content: string) {
  const parser = detectParser(file);

  if (parser === "vue") return parseVue(content);
  if (parser === "svelte") return parseSvelte(content);
  if (parser === "astro") return parseAstro(content);

  return content;
}

// VIRTUAL FILE (PATH)
function toVirtualFile(file: string) {
  return file.endsWith(".vue")
    ? file + ".tsx"
    : file;
}

// WATCH
export async function watch() {
  const config = await loadConfig();
  if (!config) return;

  console.log(chalk.blue("Watching...\n"));

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
  });

  if (!files.length) {
    console.log(chalk.yellow("No files found"));
    return;
  }

  const engine = new EventraEngine(process.cwd());

  // INITIAL SCAN
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");

      const content = preprocess(file, raw);
      const virtualFile = toVirtualFile(file);

      engine.scanFile(virtualFile, content);

    } catch {
      console.log(chalk.gray(`skip: ${file}`));
    }
  }

  config.events = engine.getAllEvents().sort();
  await saveConfig(config);

  console.log(
    chalk.gray(`Initial: ${config.events.length} events\n`)
  );

  // STATE
  let locked = false;
  let queued = new Set<string>();

  const run = async () => {
    if (locked) return;
    locked = true;

    const batch = [...queued];
    queued.clear();

    for (const file of batch) {
      try {
        const raw = await fs.readFile(file, "utf-8");

        const content = preprocess(file, raw);
        const virtualFile = toVirtualFile(file);

        engine.updateFile(virtualFile, content);

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
    queued.add(file);
    setTimeout(run, 50);
  };

  // WATCHER
  const watcher = chokidar.watch(config.sync.include, {
    ignored: config.sync.exclude,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 10,
    },
  });

  watcher
    .on("add", (file) => {
      console.log(chalk.gray(`add: ${file}`));
      schedule(file);
    })
    .on("change", (file) => {
      console.log(chalk.gray(`change: ${file}`));
      schedule(file);
    })
    .on("unlink", async (file) => {
      console.log(chalk.gray(`remove: ${file}`));

      const virtualFile = toVirtualFile(file);

      engine.removeFile?.(virtualFile);

      const next = engine.getAllEvents();

      const removed = config.events.filter(e => !next.includes(e));

      if (removed.length) {
        removed.forEach(e => console.log(chalk.red(`- ${e}`)));

        config.events = next.sort();
        await saveConfig(config);
      }
    });

  // EXIT
  process.on("SIGINT", async () => {
    console.log(chalk.yellow("\nStopping watcher..."));
    await watcher.close();
    process.exit(0);
  });
}
