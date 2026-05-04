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

      engine.scanFile(virtualFile, content, config);

    } catch (err) {
      console.log(chalk.yellow(`Skipped: ${file}`));

      if (err instanceof Error) {
        console.log(chalk.gray(err.message));
      }
    }
  }

  const found = new Set(engine.getAllEvents());
  const known = new Set(config.events ?? []);

  const newEvents = [...found].filter(e => !known.has(e));
  const removed = [...known].filter(e => !found.has(e));

  // FIX MODE
  if (fix) {
    const next = new Set<string>();

    found.forEach(e => next.add(e));

    newEvents.forEach(e =>
      console.log(chalk.green(`+ ${e}`))
    );

    removed.forEach(e =>
      console.log(chalk.red(`- ${e}`))
    );

    config.events = [...next].sort();

    await saveConfig(config);

    console.log(
      chalk.green(`\nSynced (${config.events.length} events)`)
    );

    return;
  }

  // CHECK MODE
  if (newEvents.length || removed.length) {
    if (newEvents.length) {
      console.log(chalk.red("\nNew events:"));
      newEvents.forEach(e =>
        console.log(chalk.red(`+ ${e}`))
      );
    }

    if (removed.length) {
      console.log(chalk.yellow("\nRemoved events:"));
      removed.forEach(e =>
        console.log(chalk.yellow(`- ${e}`))
      );
    }

    process.exit(1);
  }

  console.log(chalk.green("\nAll good"));
}
