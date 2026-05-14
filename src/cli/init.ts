import chalk from "chalk";
import inquirer from "inquirer";

import {saveConfig} from "../config/config";
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
  console.log(chalk.gray("Eventra automatically detects:"));
  console.log(chalk.gray("• track('event')"));
  console.log(chalk.gray("• analytics.track('event')"),);
  console.log(chalk.gray("• semantic parameter propagation"));
  console.log(chalk.gray("• cross-file wrappers"));
  console.log(chalk.gray("• parameter propagation"));
  console.log("");
  const config: EventraConfig = {
    apiKey,
    endpoint,
    events: [],
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
  console.log("");
  console.log(chalk.gray("Run `eventra sync`"));
}
