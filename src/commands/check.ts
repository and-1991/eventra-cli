import chalk from "chalk";
import fg from "fast-glob";
import { Project } from "ts-morph";
import fs from "fs/promises";

import { loadConfig } from "../utils/config";

import { detectParser } from "../utils/parsers/router";
import { parseVue } from "../utils/parsers/vue";
import { parseSvelte } from "../utils/parsers/svelte";
import { parseAstro } from "../utils/parsers/astro";

import { scanTrack } from "../utils/scanners/track";
import { scanFunctionWrappers } from "../utils/scanners/function-wrappers";
import { scanComponentWrappers } from "../utils/scanners/component-wrappers";

import { ExtractedEvent } from "../types";

export async function check() {
  const config = await loadConfig();

  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    process.exit(1);
  }

  console.log(chalk.blue("Checking events..."));

  const project = new Project();

  const knownEvents = new Set(config.events ?? []);
  const aliases = config.aliases ?? {};

  const foundEvents = new Set<string>();
  const newEvents = new Set<string>();
  const unresolvedDynamic = new Set<string>();

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude
  });

  for (const file of files) {
    try {
      // skip huge files
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) {
        console.log(chalk.gray(`Skipped large file: ${file}`));
        continue;
      }

      const parser = detectParser(file);

      let content = await fs.readFile(file, "utf-8");

      if (parser === "vue") content = parseVue(content);
      if (parser === "svelte") content = parseSvelte(content);
      if (parser === "astro") content = parseAstro(content);

      const virtualFile =
        parser === "ts" ? file : file + ".tsx";

      const source = project.createSourceFile(
        virtualFile,
        content,
        { overwrite: true }
      );

      const found: ExtractedEvent[] = [
        ...scanTrack(source, config),
        ...scanFunctionWrappers(
          source,
          config.functionWrappers ?? []
        ),
        ...scanComponentWrappers(
          source,
          config.wrappers ?? []
        )
      ];

      for (const event of found) {
        const { value, dynamic } = event;

        if (!value) continue;

        // alias skip
        if (aliases[value] === "__skip__") {
          continue;
        }

        // alias resolve
        if (aliases[value]) {
          foundEvents.add(aliases[value]);
          continue;
        }

        // dynamic without alias
        if (dynamic) {
          unresolvedDynamic.add(value);
          continue;
        }

        // static
        foundEvents.add(value);
      }

      // clear memory
      project.removeSourceFile(source);

    } catch {
      console.log(
        chalk.gray(`Skipped file (error): ${file}`)
      );
    }
  }

  // find new events
  for (const event of foundEvents) {
    if (!knownEvents.has(event)) {
      newEvents.add(event);
    }
  }

  let hasError = false;

  // dynamic
  if (unresolvedDynamic.size > 0) {
    hasError = true;

    console.log(
      chalk.red("\nUnresolved dynamic events:")
    );

    [...unresolvedDynamic]
      .sort()
      .forEach((e) =>
        console.log(chalk.red(`- ${e}`))
      );
  }

  // new events
  if (newEvents.size > 0) {
    hasError = true;

    console.log(
      chalk.red("\nNew events detected:")
    );

    [...newEvents]
      .sort()
      .forEach((e) =>
        console.log(chalk.red(`+ ${e}`))
      );
  }

  if (hasError) {
    console.log("");

    console.log(chalk.red("Event check failed"));

    console.log(
      chalk.red(
        `dynamic: ${unresolvedDynamic.size}, new: ${newEvents.size}`
      )
    );

    process.exit(1);
  }

  console.log(
    chalk.green("\nAll events are valid")
  );
}
