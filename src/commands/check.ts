import chalk from "chalk";
import fg from "fast-glob";
import { Project } from "ts-morph";
import fs from "fs/promises";
import inquirer from "inquirer";

import { loadConfig, saveConfig } from "../utils/config";

import { detectParser } from "../utils/parsers/router";
import { parseVue } from "../utils/parsers/vue";
import { parseSvelte } from "../utils/parsers/svelte";
import { parseAstro } from "../utils/parsers/astro";

import { scanTrack } from "../utils/scanners/track";
import { scanFunctionWrappers } from "../utils/scanners/function-wrappers";
import { scanComponentWrappers } from "../utils/scanners/component-wrappers";

import { ExtractedEvent } from "../types";

export async function check({ fix = false }: { fix?: boolean }) {
  const config = await loadConfig();

  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    process.exit(1);
  }

  console.log(chalk.blue("Checking events..."));

  const project = new Project();

  const knownEvents = new Set(config.events ?? []);
  const aliases = { ...(config.aliases ?? {}) };

  const foundEvents = new Map<string, ExtractedEvent>();
  const newEvents = new Map<string, ExtractedEvent>();
  const unresolvedDynamic = new Map<string, ExtractedEvent>();

  const files = await fg(config.sync.include, {
    ignore: config.sync.exclude
  });

  for (const file of files) {
    try {
      const stat = await fs.stat(file);

      if (stat.size > 2 * 1024 * 1024) {
        continue;
      }

      const parser = detectParser(file);
      let content = await fs.readFile(file, "utf-8");

      if (parser === "vue") content = parseVue(content);
      if (parser === "svelte") content = parseSvelte(content);
      if (parser === "astro") content = parseAstro(content);

      const source = project.createSourceFile(file, content, {
        overwrite: true
      });

      const found: ExtractedEvent[] = [
        ...scanTrack(source, config, aliases),
        ...scanFunctionWrappers(source, config.functionWrappers ?? [], aliases),
        ...scanComponentWrappers(source, config.wrappers ?? [], aliases)
      ];

      for (const event of found) {
        const { value, dynamic } = event;
        if (!value) continue;

        // skip
        if (aliases[value] === "__skip__") continue;

        // alias resolve
        if (value in aliases) {
          foundEvents.set(aliases[value], {
            ...event,
            value: aliases[value]
          });
          continue;
        }

        if (dynamic) {
          unresolvedDynamic.set(value, event);
          continue;
        }

        foundEvents.set(value, event);
      }

      project.removeSourceFile(source);

    } catch {
      console.log(chalk.gray(`Skipped: ${file}`));
    }
  }

  // find new
  for (const [key, event] of foundEvents) {
    if (!knownEvents.has(key)) {
      newEvents.set(key, event);
    }
  }

  // FIX MODE
  if (fix) {
    console.log(chalk.yellow("\nFix mode\n"));

    // add new events
    for (const [name] of newEvents) {
      config.events.push(name);
      console.log(chalk.green(`+ ${name}`));
    }

    // resolve dynamic
    for (const [value] of unresolvedDynamic) {
      const { action } = await inquirer.prompt([
        {
          type: "list",
          name: "action",
          message: `Dynamic: ${value}`,
          choices: [
            { name: "Alias", value: "alias" },
            { name: "Skip", value: "skip" }
          ]
        }
      ]);

      if (action === "skip") {
        aliases[value] = "__skip__";
        continue;
      }

      const { name } = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "Event name:"
        }
      ]);

      const normalized = name.trim().toLowerCase();
      if (!normalized) continue;

      aliases[value] = normalized;
      config.events.push(normalized);

      console.log(chalk.green(`${value} → ${normalized}`));
    }

    config.aliases = Object.fromEntries(
      Object.entries(aliases).sort()
    );

    config.events = [...new Set(config.events)].sort();

    await saveConfig(config);

    console.log(chalk.green("\n✔ Fixed"));
    return;
  }

  // NORMAL MODE
  let hasError = false;

  if (unresolvedDynamic.size) {
    hasError = true;

    console.log(chalk.red("\nDynamic events:"));

    unresolvedDynamic.forEach((e) =>
      console.log(
        chalk.red(`- ${e.value} (${e.file}:${e.line})`)
      )
    );
  }

  if (newEvents.size) {
    hasError = true;

    console.log(chalk.red("\nNew events:"));

    newEvents.forEach((e) =>
      console.log(
        chalk.red(`+ ${e.value} (${e.file}:${e.line})`)
      )
    );
  }

  if (hasError) {
    console.log(chalk.red("\nEvent check failed"));
    process.exit(1);
  }

  console.log(chalk.green("\nAll good"));
}
