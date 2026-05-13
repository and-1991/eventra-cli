// src/commands/sync.ts

import chalk from "chalk";

import {
  loadConfig,
  saveConfig
} from "../config/config";

import {
  scanProject
} from "../core/projectScanner";

export async function sync() {

  const config =
    await loadConfig();

  if (!config) {

    return;
  }

  console.log(
    chalk.blue(
      "Scanning..."
    )
  );

  const {
    engine,
    results,
  } = await scanProject(
    config
  );

  const detectedFn =
    new Set<string>();

  const detectedCmp =
    new Map<string, string>();

  for (
    const result
    of results.values()
    ) {

    result
      .detectedFunctionWrappers
      .forEach(
        w =>
          detectedFn.add(w)
      );

    result
      .detectedComponentWrappers
      .forEach(
        (v, k) =>
          detectedCmp.set(k, v)
      );
  }

  const events =
    engine
      .getAllEvents()
      .sort();

  config.events =
    events;

  config.functionWrappers =
    mergeUnique(
      config.functionWrappers
      ?? [],

      [...detectedFn]
        .map(name => ({
          name
        })),

      w => w.name
    );

  config.wrappers =
    mergeUnique(
      config.wrappers
      ?? [],

      [...detectedCmp.entries()]
        .map(
          ([name, prop]) => ({
            name,
            prop,
          })
        ),

      w =>
        `${w.name}:${w.prop}`
    );

  await saveConfig(
    config
  );

  console.log(
    chalk.green(
      `Found ${events.length} events`
    )
  );
}

function mergeUnique<T>(
  a: T[],
  b: T[],
  key: (
    value: T
  ) => string
): T[] {

  const map =
    new Map<string, T>();

  [...b, ...a]
    .forEach(
      item =>
        map.set(
          key(item),
          item
        )
    );

  return [
    ...map.values()
  ];
}
