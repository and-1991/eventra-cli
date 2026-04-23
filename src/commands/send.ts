import chalk from "chalk";
import inquirer from "inquirer";
import {
  loadConfig,
  saveConfig
} from "../utils/config";

import pkg from "../../package.json";

const CLI_VERSION = pkg.version;

export async function send() {
  const config = await loadConfig();

  const endpoint =
    config?.endpoint ||
    process.env.EVENTRA_ENDPOINT;

  if (!config) {
    console.log(
      chalk.red(
        "eventra.json not found. Run 'eventra init'"
      )
    );
    return;
  }

  let apiKey = config.apiKey;

  // ask api key
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
      chalk.green("API key saved")
    );
  }

  // no events
  if (!config.events?.length) {
    console.log(
      chalk.yellow(
        "No events found. Run 'eventra sync'"
      )
    );
    return;
  }

  if (!apiKey) {
    console.log(
      chalk.red("API key required")
    );
    return;
  }

  if (!endpoint) {
    console.log(
      chalk.red("Endpoint not configured")
    );
    return;
  }

  console.log("");
  console.log(
    chalk.blue(
      `Sending ${config.events.length} events...`
    )
  );

  try {
    const res = await fetch(
      endpoint,
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

    if (!res.ok) {
      console.log(
        chalk.red(
          `Request failed (${res.status})`
        )
      );

      try {
        const text =
          await res.text();

        console.log(
          chalk.gray(text)
        );
      } catch {}

      return;
    }

    const data =
      await res.json();

    console.log(
      chalk.green(
        "Events registered successfully"
      )
    );

    // created
    if (data.created?.length) {
      console.log(
        chalk.green("\nNew events:")
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

    // existing
    if (data.existing?.length) {
      console.log(
        chalk.gray(
          "\nExisting events:"
        )
      );

      data.existing.forEach(
        (e: string) =>
          console.log(
            chalk.gray(
              `• ${e}`
            )
          )
      );
    }

    // processing notice
    if (data.created?.length) {
      console.log("");
      console.log(
        chalk.yellow(
          "Events queued for processing (~2 min)"
        )
      );

      console.log(
        chalk.gray(
          "They will appear in dashboard shortly"
        )
      );
    }

    console.log("");

    console.log(
      chalk.gray(
        `Sent ${config.events.length} events`
      )
    );

  } catch (err) {
    console.log(
      chalk.red(
        "Network error"
      )
    );

    if (err instanceof Error) {
      console.log(
        chalk.gray(
          err.message
        )
      );
    }
  }
}
