import chalk from "chalk";
import inquirer from "inquirer";

import {saveConfig, saveLocalApiKey} from "../config/config";
import {detectSinkPresets} from "../plugin/builtins/sinkPresets";
import {EventraConfig, SinkRuleConfig} from "../types";
import {collectDependencyNames} from "./projectDependencies";

/**
 * Looks for analytics libraries in package.json (and workspace members) and, if there are any,
 * asks which of them Eventra should read events from. Everything detected is pre-selected.
 */
async function chooseSinks(): Promise<SinkRuleConfig[]> {
  const detected = detectSinkPresets(await collectDependencyNames(process.cwd()));
  if (detected.length === 0) return [];
  console.log(chalk.gray(`Found analytics in package.json: ${detected.map((d) => d.packages.join(", ")).join("; ")}`));
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

export async function init(): Promise<void> {
  console.log(chalk.blue("Initializing Eventra..."),);
  const {apiKey, endpoint,} = await inquirer.prompt([
    {
      type: "input",
      name: "apiKey",
      message: "API Key (optional):",
    },
    {
      type: "input",
      name: "endpoint",
      message: "Custom endpoint (optional):",
      default: "https://api.eventra.dev/api/v1/cli/events",
    },
  ]);
  const sinks = await chooseSinks();
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
