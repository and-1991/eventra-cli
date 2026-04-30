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

  const detectedFn = new Set<string>();
  const detectedCmp = new Map<string, string>();

  const fileCache: { file: string; content: string }[] = [];

  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf-8");
      const { content, virtualFile } = processFile(file, raw);

      fileCache.push({ file: virtualFile, content });

      engine["ts"].updateFile(virtualFile, content);
    } catch {
      // ignore
    }
  }

  for (const { file, content } of fileCache) {
    try {
      const res = engine.scanFile(file, content, config);

      for (const w of res.detectedFunctionWrappers) {
        detectedFn.add(w);
      }

      for (const [k, v] of res.detectedComponentWrappers) {
        detectedCmp.set(k, v);
      }

    } catch (err) {
      console.log(chalk.yellow(`Skipped: ${file}`));

      if (err instanceof Error) {
        console.log(chalk.gray(err.message));
      }
    }
  }

  // EVENTS
  const events = engine.getAllEvents().sort();

  const mergedEvents = new Set(config.events ?? []);
  events.forEach(e => mergedEvents.add(e));

  config.events = [...mergedEvents].sort();

  // FUNCTION WRAPPERS
  config.functionWrappers = mergeUnique(
    config.functionWrappers ?? [],
    [...detectedFn].map(name => ({ name })),
    w => w.name
  );

  // COMPONENT WRAPPERS
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

  if (detectedFn.size) {
    console.log(chalk.blue("\nDetected function wrappers:"));
    detectedFn.forEach(w => console.log(chalk.gray(`• ${w}`)));
  }

  if (detectedCmp.size) {
    console.log(chalk.blue("\nDetected component wrappers:"));
    detectedCmp.forEach((prop, name) =>
      console.log(chalk.gray(`• ${name} (${prop})`))
    );
  }
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
