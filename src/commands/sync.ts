import fg from "fast-glob";
import fs from "fs/promises";
import chalk from "chalk";

import { loadConfig, saveConfig } from "../utils/config";
import { EventraEngine } from "../engine/engine";
import { processFile } from "../utils/processFile";

export async function sync() {
  const config = await loadConfig();
  if (!config) return;

  console.log(chalk.blue("Scanning..."));

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
  });

  if (!files.length) {
    console.log(chalk.yellow("No files found"));
    return;
  }

  const engine = new EventraEngine(process.cwd());

  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");

      const { content, virtualFile } = processFile(file, raw);

      engine.scanFile(virtualFile, content);

    } catch (e) {
      console.log(chalk.red(`ERROR: ${file}`));
      console.error(e);
    }
  }

  const events = engine.getAllEvents().sort();

  config.events = events;
  await saveConfig(config);

  console.log(chalk.green(`Found ${events.length} events`));
}
