import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import inquirer from "inquirer";
import {
  CONFIG_NAME,
  saveConfig
} from "../utils/config";

export async function init() {
  console.log(
    chalk.blue("Initializing Eventra...")
  );

  const configPath = path.join(
    process.cwd(),
    CONFIG_NAME
  );

  if (await fs.pathExists(configPath)) {
    console.log(
      chalk.yellow(
        "eventra.json already exists"
      )
    );
    return;
  }

  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "apiKey",
      message:
        "API Key (optional):"
    }
  ]);

  const config = {
    apiKey: answers.apiKey || "",
    events: [],
    wrappers: [],
    functionWrappers: [],
    sync: {
      include: ["**/*.{ts,tsx,js,jsx}"],
      exclude: [
        "node_modules",
        "dist",
        ".next",
        ".git"
      ]
    }
  };

  await saveConfig(config);

  console.log(
    chalk.green(
      "eventra.json created"
    )
  );
}
