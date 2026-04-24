import chalk from "chalk";
import fg from "fast-glob";
import fs from "fs/promises";

import { loadConfig, saveConfig } from "../utils/config";
import { EventraEngine } from "../engine/engine";
import { processFile } from "../utils/processFile";

export async function check({ fix = false }: { fix?: boolean }) {
  const config = await loadConfig();

  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    process.exit(1);
  }

  console.log(chalk.blue("Checking events..."));

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
  });

  const engine = new EventraEngine(process.cwd());

  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");

      const { content, virtualFile } = processFile(file, raw);

      engine.scanFile(virtualFile, content);

    } catch {
      console.log(chalk.gray(`Skipped: ${file}`));
    }
  }

  const found = new Set(engine.getAllEvents());
  const known = new Set(config.events ?? []);

  const newEvents = [...found].filter(e => !known.has(e));

  if (fix) {
    newEvents.forEach(e => {
      config.events.push(e);
      console.log(chalk.green(`+ ${e}`));
    });

    config.events = [...new Set(config.events)].sort();

    await saveConfig(config);

    console.log(chalk.green("\nFixed"));
    return;
  }

  if (newEvents.length) {
    console.log(chalk.red("\nNew events:"));
    newEvents.forEach(e => console.log(chalk.red(`+ ${e}`)));

    process.exit(1);
  }

  console.log(chalk.green("\nAll good"));
}
