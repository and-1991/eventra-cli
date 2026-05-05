import fg from "fast-glob";
import fs from "fs/promises";
import chalk from "chalk";
import path from "path";

import { loadConfig, saveConfig } from "../utils/config";
import { EventraEngine } from "../engine/engine";
import { processFile } from "../utils/processFile";
import { getVirtualFile } from "../utils/getVirtualFile";

export async function sync() {
  const config = await loadConfig();
  if (!config) return;

  console.log(chalk.blue("Scanning..."));

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
      let parsed = cache.get(file);

      if (!parsed) {
        const raw = await fs.readFile(file, "utf-8");
        parsed = processFile(file, raw);
        cache.set(file, parsed);
      }

      engine.preloadFile(getVirtualFile(file), parsed.content);

    } catch {}
  }

  // SCAN
  const detectedFn = new Set<string>();
  const detectedCmp = new Map<string, string>();

  for (const file of toScan) {
    try {
      const parsed = cache.get(file);
      if (!parsed) continue;

      const res = engine.updateFile(
        getVirtualFile(file),
        parsed.content,
        config
      );

      res.detectedFunctionWrappers.forEach(w => detectedFn.add(w));
      res.detectedComponentWrappers.forEach((v, k) => detectedCmp.set(k, v));

    } catch {}
  }

  // RESULT
  const events = engine.getAllEvents().sort();

  config.events = events;

  config.functionWrappers = mergeUnique(
    config.functionWrappers ?? [],
    [...detectedFn].map(name => ({ name })),
    w => w.name
  );

  config.wrappers = mergeUnique(
    config.wrappers ?? [],
    [...detectedCmp.entries()].map(([name, prop]) => ({ name, prop })),
    w => `${w.name}:${w.prop}`
  );

  await saveConfig(config);

  console.log(chalk.green(`Found ${events.length} events`));
}

function mergeUnique<T>(a: T[], b: T[], key: (v: T) => string): T[] {
  const map = new Map<string, T>();
  [...b, ...a].forEach(item => map.set(key(item), item));
  return [...map.values()];
}
