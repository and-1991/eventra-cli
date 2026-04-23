import chalk from "chalk";
import inquirer from "inquirer";

import { saveConfig } from "../utils/config";
import {ComponentWrapper, FunctionWrapper} from "../types";

export async function init() {
  console.log(
    chalk.blue("Initializing Eventra...")
  );

  // API KEY ENDPOINT
  const { apiKey, endpoint } =
    await inquirer.prompt([
      {
        type: "input",
        name: "apiKey",
        message:
          "API Key (optional):"
      },
      {
        type: "input",
        name: "endpoint",
        message: "Custom endpoint (optional):",
        default: "https://api.eventra.dev/events"
      }
    ]);

  console.log(
    chalk.gray(
      "\nEventra automatically detects:"
    )
  );

  console.log(
    chalk.gray("• track('event')")
  );

  console.log(
    chalk.gray(
      "• tracker.track('event')"
    )
  );

  const wrappers: ComponentWrapper[] = [];
  const functionWrappers: FunctionWrapper[] = [];


  // COMPONENT WRAPPERS
  console.log(
    chalk.blue(
      "\nComponent wrappers"
    )
  );

  let addComponent = true;

  while (addComponent) {
    const { useWrapper } =
      await inquirer.prompt([
        {
          type: "confirm",
          name: "useWrapper",
          message:
            "Add component wrapper?",
          default: false
        }
      ]);

    if (!useWrapper) break;

    const { name, prop } =
      await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "Component name:",
          validate: (v) =>
            v ? true : "Required"
        },
        {
          type: "input",
          name: "prop",
          message:
            "Event prop:",
          default: "event"
        }
      ]);

    wrappers.push({
      name,
      prop
    });
  }

  // FUNCTION WRAPPERS
  console.log(
    chalk.blue(
      "\nFunction wrappers"
    )
  );

  let addFunction = true;

  while (addFunction) {
    const { useWrapper } =
      await inquirer.prompt([
        {
          type: "confirm",
          name: "useWrapper",
          message:
            "Add function wrapper?",
          default: false
        }
      ]);

    if (!useWrapper) break;

    const { name, event } =
      await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message:
            "Function name:"
        },
        {
          type: "input",
          name: "event",
          message:
            "Event field (leave empty if string argument):",
          default: ""
        }
      ]);

    functionWrappers.push({
      name,
      event: event || undefined
    });
  }

  const config = {
    apiKey,
    endpoint,
    events: [],
    wrappers,
    functionWrappers,
    sync: {
      include: [
        "**/*.{ts,tsx,js,jsx,vue,svelte,astro}"
      ],
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
      "\neventra.json created"
    )
  );

  console.log(
    chalk.gray(
      "\nRun `eventra sync`"
    )
  );
}
