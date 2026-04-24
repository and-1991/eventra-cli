import chokidar from "chokidar";
import chalk from "chalk";
import { Project } from "ts-morph";
import fs from "fs/promises";

import { loadConfig, saveConfig } from "../utils/config";

import { detectParser } from "../utils/parsers/router";
import { parseVue } from "../utils/parsers/vue";
import { parseSvelte } from "../utils/parsers/svelte";
import { parseAstro } from "../utils/parsers/astro";

import { scanTrack } from "../utils/scanners/track";
import { scanFunctionWrappers } from "../utils/scanners/function-wrappers";
import { scanComponentWrappers } from "../utils/scanners/component-wrappers";

export async function watch() {
  const config = await loadConfig();

  if (!config) {
    console.log(chalk.red("Run init first"));
    return;
  }

  console.log(chalk.blue("Watching...\n"));

  const project = new Project();

  const aliases = config.aliases ?? {};

  // уже известные события
  const seen = new Set(config.events);

  const queue = new Set<string>();
  let timer: NodeJS.Timeout;

  const processQueue = async () => {
    const files = [...queue];
    queue.clear();

    for (const file of files) {
      await handle(file);
    }

    config.events = [...new Set(config.events)].sort();

    await saveConfig(config);
  };

  const handle = async (file: string) => {
    try {
      let content = await fs.readFile(file, "utf-8");

      const parser = detectParser(file);

      if (parser === "vue") content = parseVue(content);
      if (parser === "svelte") content = parseSvelte(content);
      if (parser === "astro") content = parseAstro(content);

      const source = project.createSourceFile(file, content, {
        overwrite: true
      });

      const found = [
        ...scanTrack(source, config, aliases),
        ...scanFunctionWrappers(source, config.functionWrappers ?? [], aliases),
        ...scanComponentWrappers(source, config.wrappers ?? [], aliases)
      ];

      for (const e of found) {
        if (!e.value) continue;

        if (aliases[e.value] === "__skip__") continue;

        if (e.value in aliases) continue;

        if (seen.has(e.value)) continue;

        seen.add(e.value);

        if (!e.dynamic) {
          config.events.push(e.value);
          console.log(chalk.green(`+ ${e.value}`));
        } else {
          console.log(chalk.yellow(`Dynamic: ${e.value}`));
        }
      }

      project.removeSourceFile(source);

    } catch {
      console.log(chalk.gray(`skip: ${file}`));
    }
  };

  const watcher = chokidar.watch(config.sync.include, {
    ignored: [
      ...config.sync.exclude,
      "**/*.log",
      "**/*.tmp",
      "**/*.swp"
    ],
    ignoreInitial: true
  });

  watcher.on("change", (file) => {
    queue.add(file);

    clearTimeout(timer);

    timer = setTimeout(processQueue, 200);
  });
}
