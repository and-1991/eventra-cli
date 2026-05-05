import chalk from "chalk";
import fg from "fast-glob";
import fs from "fs/promises";
import path from "path";

import { loadConfig, saveConfig } from "../utils/config";
import { EventraEngine } from "../engine/engine";
import { processFile } from "../utils/processFile";
import { getVirtualFile } from "../utils/getVirtualFile";

export async function check({ fix = false }: { fix?: boolean }) {
  const config = await loadConfig();

  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    process.exit(1);
  }

  console.log(chalk.blue("Checking events..."));

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude,
    absolute: true,
  });

  const engine = new EventraEngine(process.cwd());

  const cache = new Map<string, { content: string; deps: string[] }>();
  const toScan = new Set<string>();

  // COLLECT
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");
      if (raw.length > 2_000_000) continue;

      const parsed = processFile(file, raw);

      cache.set(file, parsed);
      toScan.add(file);
      parsed.deps.forEach(dep => toScan.add(path.resolve(dep)));

    } catch {}
  }

  // PRELOAD
  for (const file of toScan) {
    try {
      const parsed = cache.get(file);
      if (!parsed) continue;
      engine.preloadFile(getVirtualFile(file), parsed.content);
    } catch {}
  }

  // SCAN
  for (const file of toScan) {
    try {
      const parsed = cache.get(file);
      if (!parsed) continue;

      engine.scanFile(
        getVirtualFile(file),
        parsed.content,
        config
      );

    } catch {}
  }

  const found = new Set(engine.getAllEvents());
  const known = new Set(config.events ?? []);

  const added = [...found].filter(e => !known.has(e));
  const removed = [...known].filter(e => !found.has(e));

  if (fix) {
    config.events = [...found].sort();
    await saveConfig(config);
    console.log(chalk.green("Synced"));
    return;
  }

  if (added.length || removed.length) {
    added.forEach(e => console.log(chalk.red(`+ ${e}`)));
    removed.forEach(e => console.log(chalk.yellow(`- ${e}`)));

    process.exit(1);
  }

  console.log(chalk.green("All good"));
}
