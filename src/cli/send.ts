import chalk from "chalk";
import inquirer from "inquirer";

import {loadConfig, saveConfig} from "../config/config";
import pkg from "../../package.json";

const CLI_VERSION = pkg.version;

// retry/backoff tuning (mirrors SDK defaults)
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const FETCH_TIMEOUT_MS = 10_000;

// sleep helper for backoff
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// exponential backoff with jitter (capped)
function backoffMs(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return exp * (0.5 + Math.random() * 0.5);
}

// single delivery attempt with abort timeout
async function attemptDelivery(
  endpoint: string,
  apiKey: string,
  payload: string,
): Promise<{ ok: true; data: SendResponse } | { ok: false; status: number; body?: string; retryable: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: payload,
      signal: controller.signal,
    });

    if (res.ok) {
      const data = (await res.json()) as SendResponse;
      return { ok: true, data };
    }

    let body: string | undefined;
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }

    // 429 and 5xx are transient — worth retrying
    const retryable = res.status === 429 || res.status >= 500;
    return { ok: false, status: res.status, body, retryable };
  } finally {
    clearTimeout(timeout);
  }
}

type SendResponse = {
  created?: string[];
  existing?: string[];
};

export async function send() {
  const config = await loadConfig();
  const endpoint = config?.endpoint || process.env.EVENTRA_ENDPOINT;
  if (!config) {
    console.log(chalk.red("eventra.json not found. Run 'eventra init'"));
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
          message: "Enter your API key:"
        }
      ]);
    apiKey = answers.apiKey;
    await saveConfig({
      ...config,
      apiKey,
    });
    console.log(chalk.green("API key saved"));
  }
  // no events
  if (!config.events?.length) {
    console.log(chalk.yellow("No events found. Run 'eventra sync'"));
    return;
  }
  if (!apiKey) {
    console.log(chalk.red("API key required"));
    return;
  }
  if (!endpoint) {
    console.log(chalk.red("Endpoint not configured"));
    return;
  }
  console.log("");
  console.log(chalk.blue(`Sending ${config.events.length} events...`));

  const payload = JSON.stringify({
    events: config.events,
    cli: {
      name: "@eventra_dev/eventra-cli",
      version: CLI_VERSION,
      runtime: "node",
    },
  });

  // attempt delivery with retry on 429/5xx/network errors
  let data: SendResponse | undefined;
  let lastFailure: { status?: number; body?: string; error?: unknown } | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const outcome = await attemptDelivery(endpoint, apiKey, payload);

      if (outcome.ok) {
        data = outcome.data;
        break;
      }

      if (!outcome.retryable) {
        // permanent failure — surface immediately
        console.log(chalk.red(`Request failed (${outcome.status})`));
        if (outcome.body) console.log(chalk.gray(outcome.body));
        return;
      }

      lastFailure = { status: outcome.status, body: outcome.body };

      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffMs(attempt);
        console.log(
          chalk.yellow(
            `Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (${outcome.status}). Retrying in ${Math.round(delay)} ms...`,
          ),
        );
        await sleep(delay);
      }
    } catch (err) {
      lastFailure = { error: err };

      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffMs(attempt);
        console.log(
          chalk.yellow(
            `Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (network error). Retrying in ${Math.round(delay)} ms...`,
          ),
        );
        await sleep(delay);
      }
    }
  }

  if (!data) {
    console.log(chalk.red("All retries exhausted"));
    if (lastFailure?.status) {
      console.log(chalk.gray(`Last status: ${lastFailure.status}`));
      if (lastFailure.body) console.log(chalk.gray(lastFailure.body));
    } else if (lastFailure?.error instanceof Error) {
      console.log(chalk.gray(lastFailure.error.message));
    }
    return;
  }

  console.log(chalk.green("Events registered successfully"));
  // created events
  if (data.created?.length) {
    console.log(chalk.green("\nNew events:"));
    data.created.forEach((e: string) => console.log(chalk.green(`+ ${e}`)));
  }
  // existing events
  if (data.existing?.length) {
    console.log(chalk.gray("\nExisting events:"));
    data.existing.forEach((e: string) => console.log(chalk.gray(`• ${e}`)));
  }
  // processing notice
  if (data.created?.length) {
    console.log("");
    console.log(chalk.yellow("Events queued for processing (~2 min)"));
    console.log(chalk.gray("They will appear in dashboard shortly"));
  }
  console.log("");
  console.log(chalk.gray(`Sent ${config.events.length} events`));
}
