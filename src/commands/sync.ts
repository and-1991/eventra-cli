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

  if (!files.length) {
    console.log(chalk.yellow("No files found"));
    return;
  }

  const engine = new EventraEngine(process.cwd());

  const toScan = new Set<string>();

  const cache = new Map<
    string,
    { content: string; deps: string[] }
  >();

  // COLLECT + CACHE
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");

      if (raw.length > 2_000_000) continue;

      const parsed = processFile(file, raw);

      cache.set(file, parsed);
      toScan.add(file);

      for (const dep of parsed.deps) {
        toScan.add(path.resolve(dep));
      }

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

      const virtual = getVirtualFile(file);
      engine.preloadFile(virtual, parsed.content);

    } catch {}
  }

  // SCAN
  const detectedFn = new Set<string>();
  const detectedCmp = new Map<string, string>();

  for (const file of toScan) {
    try {
      const parsed = cache.get(file);
      if (!parsed) continue;

      const virtual = getVirtualFile(file);

      const res = engine.scanFile(virtual, parsed.content, config);

      res.detectedFunctionWrappers.forEach(w =>
        detectedFn.add(w)
      );

      for (const [k, v] of res.detectedComponentWrappers) {
        detectedCmp.set(k, v);
      }

    } catch {
      console.log(chalk.gray(`skip: ${file}`));
    }
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
    [...detectedCmp.entries()].map(([name, prop]) => ({
      name,
      prop,
    })),
    w => `${w.name}:${w.prop}`
  );

  await saveConfig(config);

  console.log(chalk.green(`Found ${events.length} events`));
}

// HELPERS
function mergeUnique<T>(
  a: T[],
  b: T[],
  key: (v: T) => string
): T[] {
  const map = new Map<string, T>();

  [...b, ...a].forEach(item => {
    map.set(key(item), item);
  });

  return [...map.values()];
}
