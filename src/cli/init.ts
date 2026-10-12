import chalk from "chalk";
import fs from "fs-extra";
import inquirer from "inquirer";
import path from "path";

import {CONFIG_NAME, saveConfig, saveLocalApiKey} from "../config/config";
import {detectSinkPresets} from "../plugin/builtins/sinkPresets";
import {EventraConfig, SinkRuleConfig} from "../types";
import {collectDependencyNames} from "./projectDependencies";

/**
 * Looks for analytics libraries in package.json (and workspace members) and, if there are any,
 * asks which of them Eventra should read events from. Everything detected is pre-selected.
 */
async function chooseSinks(yes: boolean): Promise<SinkRuleConfig[]> {
  const detected = detectSinkPresets(await collectDependencyNames(process.cwd()));
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

const DEFAULT_ENDPOINT = "https://api.eventra.dev/api/v1/cli/events";

/**
 * `yes` is the non-interactive mode (CI, scripts): defaults for every answer,
 * and an existing eventra.json is never overwritten.
 */
export async function init({yes = false}: { yes?: boolean } = {}): Promise<void> {
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
  const sinks = await chooseSinks(yes);
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
    ...(sinks.length > 0 ? {sinks} : {}),
    sync: {
      include: [
        "**/*.{ts,tsx,js,jsx}",
      ],
      exclude: [
        "node_modules",
        "dist",
        ".next",
        ".git",
      ],
    },
  };
  await saveConfig(config);
  console.log(chalk.green("eventra.json created"),);
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
