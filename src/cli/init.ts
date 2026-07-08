import chalk from "chalk";
import inquirer from "inquirer";

import {saveConfig, saveLocalApiKey} from "../config/config";
import {EventraConfig} from "../types";

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

  // Never write the key into eventra.json — that file is meant to be
  // committed (CI diffs it via `eventra check`). Keep secrets out of git.
  if (apiKey) {
    await saveLocalApiKey(apiKey);
    console.log(chalk.green("API key saved to eventra.local.json (added to .gitignore)"));
  }

  console.log("");
  console.log(chalk.gray("Run `eventra sync`"));
}
