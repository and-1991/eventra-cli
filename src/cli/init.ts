import chalk from "chalk";
import fs from "fs-extra";
import inquirer from "inquirer";
import {createRequire} from "module";
import path from "path";

import {CONFIG_NAME, INIT_EXCLUDE, saveConfig, saveLocalApiKey} from "../config/config";
import {detectSinkPresets} from "../plugin/builtins/sinkPresets";
import {EventraConfig, SinkRuleConfig} from "../types";
import {collectDependencyNames} from "./projectDependencies";

/**
 * Looks for analytics libraries in package.json (and workspace members) and, if there are any,
 * asks which of them Eventra should read events from. Everything detected is pre-selected.
 */
async function chooseSinks(yes: boolean, dependencyNames: ReadonlySet<string>): Promise<SinkRuleConfig[]> {
  const detected = detectSinkPresets(dependencyNames);
  if (detected.length === 0) return [];
  console.log(chalk.gray(`Found analytics in package.json: ${detected.map((d) => d.packages.join(", ")).join("; ")}`));
  if (yes) return detected.map((d) => ({preset: d.preset}));
  const {presets} = await inquirer.prompt<{ presets: string[] }>([
    {
      type: "checkbox",
      name: "presets",
      message: "Also read events from these analytics calls (sinks):",
      choices: detected.map((d) => ({
        name: `${d.preset} (${d.packages.join(", ")})`,
        value: d.preset,
        checked: true,
      })),
    },
  ]);
  return presets.map((preset) => ({preset}));
}

/** Framework dependency -> the plugin that reads its template files (`.vue`, `.svelte`, `.astro`, Angular templates). */
const FRAMEWORK_PLUGINS: Readonly<Record<string, string>> = {
  vue: "@eventra_dev/cli-plugin-vue",
  svelte: "@eventra_dev/cli-plugin-svelte",
  astro: "@eventra_dev/cli-plugin-astro",
  "@angular/core": "@eventra_dev/cli-plugin-angular",
};

/** True when the plugin package can be loaded from the project, which is where `sync` will look for it. */
export function isInstalled(plugin: string): boolean {
  try {
    createRequire(path.join(process.cwd(), "package.json")).resolve(plugin);
    return true;
  } catch {
    return false;
  }
}

/**
 * The plugins for the frameworks found in package.json (and workspace members), split by whether they are
 * installed. Without a plugin, events fired from component files are never seen. Only an installed one is
 * written to `plugins`: `sync` stops on a plugin it cannot load, and an `init` followed by `sync` must not.
 */
function detectPlugins(
  dependencyNames: ReadonlySet<string>,
  installed: (plugin: string) => boolean,
): { enabled: string[]; missing: string[] } {
  const found = Object.entries(FRAMEWORK_PLUGINS)
    .filter(([dependency]) => dependencyNames.has(dependency))
    .map(([, plugin]) => plugin);
  return { enabled: found.filter(installed), missing: found.filter((plugin) => !installed(plugin)) };
}

const DEFAULT_ENDPOINT = "https://api.eventra.dev/api/v1/cli/events";

/**
 * `yes` is the non-interactive mode (CI, scripts): defaults for every answer,
 * and an existing eventra.json is never overwritten.
 */
export async function init(
  {yes = false, isPluginInstalled = isInstalled}: { yes?: boolean; isPluginInstalled?: (plugin: string) => boolean } = {},
): Promise<void> {
  if (await fs.pathExists(path.join(process.cwd(), CONFIG_NAME))) {
    if (yes) {
      console.log(chalk.yellow(`${CONFIG_NAME} already exists, keeping it`));
      return;
    }
    const {overwrite} = await inquirer.prompt<{ overwrite: boolean }>([
      {
        type: "confirm",
        name: "overwrite",
        message: `${CONFIG_NAME} already exists. Overwrite it? Its events, wrappers, plugins and sinks will be lost.`,
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.gray(`Kept the existing ${CONFIG_NAME}`));
      return;
    }
  }
  console.log(chalk.blue("Initializing Eventra..."),);
  const {apiKey, endpoint,} = yes
    ? {apiKey: "", endpoint: DEFAULT_ENDPOINT}
    : await inquirer.prompt([
      {
        type: "input",
        name: "apiKey",
        message: "API Key (optional):",
      },
      {
        type: "input",
        name: "endpoint",
        message: "Custom endpoint (optional):",
        default: DEFAULT_ENDPOINT,
      },
    ]);
  const dependencyNames = await collectDependencyNames(process.cwd());
  const sinks = await chooseSinks(yes, dependencyNames);
  const {enabled: plugins, missing: missingPlugins} = detectPlugins(dependencyNames, isPluginInstalled);
  console.log("");
  console.log(chalk.gray("Eventra detects @eventra_dev/eventra-sdk usage:"));
  console.log(chalk.gray('• tracker.track("event.name")'));
  console.log(chalk.gray("• function wrappers → Eventra.track()"));
  console.log(chalk.gray("• cross-file propagation chains"));
  console.log("");
  const config: EventraConfig = {
    apiKey: "",
    endpoint,
    events: [],
    functionWrappers: [],
    ...(plugins.length > 0 ? {plugins} : {}),
    ...(sinks.length > 0 ? {sinks} : {}),
    sync: {
      include: [
        "**/*.{ts,tsx,js,jsx}",
      ],
      exclude: [...INIT_EXCLUDE],
    },
  };
  await saveConfig(config);
  console.log(chalk.green("eventra.json created"),);
  if (plugins.length > 0) {
    console.log(chalk.green(`plugins: ${plugins.join(", ")}`));
  }
  if (missingPlugins.length > 0) {
    console.log(chalk.yellow(`Component files are not read yet: npm install -D ${missingPlugins.join(" ")}`));
    console.log(chalk.yellow(`then add ${missingPlugins.map((p) => `"${p}"`).join(", ")} to "plugins" in ${CONFIG_NAME}`));
  }
  if (sinks.length > 0) {
    console.log(chalk.green(`sinks: ${sinks.map((s) => s.preset).join(", ")}`));
  }

  // Never write the key into eventra.json — that file is meant to be
  // committed (CI diffs it via `eventra check`). Keep secrets out of git.
  if (apiKey) {
    await saveLocalApiKey(apiKey);
    console.log(chalk.green("API key saved to eventra.local.json (added to .gitignore)"));
  }

  console.log("");
  console.log(chalk.gray("Run `eventra sync`"));
}
