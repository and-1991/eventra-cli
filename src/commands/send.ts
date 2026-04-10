import chalk from "chalk";
import inquirer from "inquirer";
import {
  loadConfig,
  saveConfig
} from "../utils/config";

const EVENTRA_ENDPOINT =
  "http://localhost:4000/api/v1/cli/events";

const CLI_VERSION = "0.0.1";

export async function send() {
  let config = await loadConfig();

  if (!config) {
    console.log(
      chalk.red(
        "eventra.json not found. Run 'eventra init'"
      )
    );
    return;
  }

  let apiKey = config.apiKey;

  if (!apiKey) {
    const answers =
      await inquirer.prompt([
        {
          type: "input",
          name: "apiKey",
          message:
            "Enter your API key:"
        }
      ]);

    apiKey = answers.apiKey;

    config.apiKey = apiKey;

    await saveConfig(config);

    console.log(
      chalk.green(
        "API key saved"
      )
    );
  }

  if (!config.events.length) {
    console.log(
      chalk.yellow(
        "No events found. Run 'eventra sync'"
      )
    );
    return;
  }

  console.log(
    chalk.blue("Sending events...")
  );

  try {
    const res = await fetch(EVENTRA_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify({
          events: config.events,
          cli: {
            name:
              "@eventra_dev/eventra-cli",
            version: CLI_VERSION,
            runtime: "node"
          }
        })
      }
    );

    if (res.status >= 400) {
      console.log(
        chalk.red(
          `Failed (${res.status})`
        )
      );

      return;
    }

    const data = await res.json();

    console.log(
      chalk.green(
        "Events registered successfully"
      )
    );

    if (data.created?.length) {
      console.log(
        chalk.green(
          "\nNew events:"
        )
      );

      data.created.forEach(
        (e: string) =>
          console.log(
            chalk.green(
              `+ ${e}`
            )
          )
      );
    }

  } catch {
    console.log(
      chalk.red("Network error")
    );
  }
}
