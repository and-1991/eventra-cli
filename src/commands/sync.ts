import chalk from "chalk";
import fg from "fast-glob";
import {Project} from "ts-morph";
import fs from "fs/promises";
import inquirer from "inquirer";

import {loadConfig, saveConfig} from "../utils/config";

import {detectWrappers} from "../utils/detect-wrappers";
import {detectAliases} from "../utils/detect-aliases";

import {detectParser} from "../utils/parsers/router";
import {parseVue} from "../utils/parsers/vue";
import {parseSvelte} from "../utils/parsers/svelte";
import {parseAstro} from "../utils/parsers/astro";

import {scanTrack} from "../utils/scanners/track";
import {scanFunctionWrappers} from "../utils/scanners/function-wrappers";
import {scanComponentWrappers} from "../utils/scanners/component-wrappers";

import {ExtractedEvent} from "../types";

export async function sync() {
  const config = await loadConfig();

  if (!config) {
    console.log(chalk.red("Run 'eventra init'"));
    return;
  }

  console.log(chalk.blue("Scanning project..."));

  const project = new Project();

  const events = new Set<string>();
  const aliases = config.aliases ?? {};
  const asked = new Set<string>();

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude
  });

  for (const file of files) {
    try {
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
        {overwrite: true}
      );


      // AUTO ALIASES
      const detectedAliases = detectAliases(source);

      for (const key in detectedAliases) {
        if (!(key in aliases)) {
          aliases[key] = detectedAliases[key];

          console.log(
            chalk.green(
              `Detected alias: ${key} → ${detectedAliases[key]}`
            )
          );
        }
      }


      // AUTO WRAPPERS
      const detected = detectWrappers(source);

      // function wrappers
      for (const fn of detected.functions) {
        if (
          !config.functionWrappers?.some(
            (w) => w.name === fn.name
          )
        ) {
          config.functionWrappers.push(fn);

          console.log(
            chalk.green(
              `Detected function wrapper: ${fn.name}`
            )
          );
        }
      }

      // component wrappers
      for (const comp of detected.components) {
        if (
          !config.wrappers?.some(
            (w) => w.name === comp.name
          )
        ) {
          config.wrappers.push(comp);

          console.log(
            chalk.green(
              `Detected component wrapper: ${comp.name} (prop: ${comp.prop})`
            )
          );
        }
      }

      // SCAN EVENTS
      const found: ExtractedEvent[] = [
        ...scanTrack(source, config, aliases),
        ...scanFunctionWrappers(
          source,
          config.functionWrappers ?? [],
          aliases
        ),
        ...scanComponentWrappers(
          source,
          config.wrappers ?? [],
          aliases
        )
      ];

      for (const event of found) {
        const {value, dynamic} = event;

        if (!value) continue;

        // skip explicit ignore
        if (value in aliases && aliases[value] === "__skip__") {
          continue;
        }

        // resolve alias
        if (value in aliases) {
          events.add(aliases[value]);
          continue;
        }

        // static
        if (!dynamic) {
          events.add(value);
          continue;
        }

        // already handled
        if (asked.has(value)) continue;

        // ASK ONLY IF NEEDED
        console.log(
          chalk.yellow("\nDynamic event detected:")
        );
        console.log(chalk.gray(value));

        const {name} = await inquirer.prompt([
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

        console.log(
          chalk.green(
            `Saved alias: ${value} → ${normalized}`
          )
        );

        events.add(normalized);
      }

      // free memory
      project.removeSourceFile(source);

    } catch {
      console.log(
        chalk.gray(`Skipped file: ${file}`)
      );
    }
  }
  // SAVE CONFIG
  config.aliases = Object.fromEntries(
    Object.entries(aliases).sort()
  );

  // MERGE
  const merged = new Set([
    ...config.events,
    ...events
  ]);

  config.events = [...merged].sort();

  await saveConfig(config);

  console.log(
    chalk.green(`\nFound ${config.events.length} events`)
  );
}
