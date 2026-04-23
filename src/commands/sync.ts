import chalk from "chalk";
import fg from "fast-glob";
import { Project } from "ts-morph";
import fs from "fs/promises";
import inquirer from "inquirer";

import {
  loadConfig,
  saveConfig
} from "../utils/config";

import { detectParser } from "../utils/parsers/router";
import { parseVue } from "../utils/parsers/vue";
import { parseSvelte } from "../utils/parsers/svelte";
import { parseAstro } from "../utils/parsers/astro";

import { scanTrack } from "../utils/scanners/track";
import { scanFunctionWrappers } from "../utils/scanners/function-wrappers";
import { scanComponentWrappers } from "../utils/scanners/component-wrappers";

import { ExtractedEvent } from "../types";

export async function sync() {
  const config = await loadConfig();

  if (!config) {
    console.log(
      chalk.red("Run 'eventra init'")
    );
    return;
  }

  console.log(
    chalk.blue("Scanning project...")
  );

  const project = new Project();
  const events = new Set<string>();

  const aliases = config.aliases ?? {};
  const asked = new Set<string>();

  const files = await fg(
    config.sync.include,
    {
      ignore: config.sync.exclude
    }
  );

  for (const file of files) {
    const parser = detectParser(file);

    let content = await fs.readFile(
      file,
      "utf-8"
    );

    if (parser === "vue")
      content = parseVue(content);

    if (parser === "svelte")
      content = parseSvelte(content);

    if (parser === "astro")
      content = parseAstro(content);

    const virtualFile =
      parser === "ts"
        ? file
        : file + ".tsx";

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

      // alias
      if (aliases[value]) {
        console.log(
          chalk.gray(`alias: ${value} → ${aliases[value]}`)
        );
        events.add(aliases[value]);
        continue;
      }

      // static
      if (!dynamic) {
        events.add(value);
        continue;
      }

      // already asked
      if (asked.has(value)) {
        continue;
      }

      // ask user
      console.log(
        chalk.yellow("\nDynamic event detected:")
      );
      console.log(chalk.gray(value));

      const { name } = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message:
            "Enter event name (or type 'skip'):"
        }
      ]);

      const normalized = name?.trim();

      asked.add(value);

      if (!normalized || normalized === "skip") {
        continue;
      }

      // save alias
      aliases[value] = normalized;

      events.add(normalized);
    }
  }

  config.aliases = aliases;

  const list = [...events].sort();
  config.events = list;

  await saveConfig(config);

  console.log(
    chalk.green(
      `Found ${list.length} events`
    )
  );
}
