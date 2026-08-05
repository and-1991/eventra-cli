import chalk from "chalk";
import inquirer from "inquirer";

import {getTrustedEndpoint, loadConfig, resolveApiKey, saveLocalApiKey, trustEndpoint} from "../config/config";
import pkg from "../../package.json";

const CLI_VERSION = pkg.version;

// Always trusted, no local approval needed — matches `eventra init`'s prompt default.
const DEFAULT_SEND_ENDPOINT = "https://api.eventra.dev/api/v1/cli/events";

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
  // Exercising this callback for real means either a genuine 10s wait per
  // attempt (too slow for a unit test, especially across MAX_ATTEMPTS
  // retries) or faking timers through an AbortController+fetch+retry-loop
  // chain, which deadlocks vi.runAllTimersAsync/advanceTimersByTimeAsync in
  // practice - not worth the added flakiness for one timeout wire-up line.
  /* v8 ignore next */
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

export async function send(opts: { trustEndpoint?: boolean } = {}) {
  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("eventra.json not found. Run 'eventra init'"));
    process.exitCode = 1;
    return;
  }

  const endpoint = config.endpoint || process.env.EVENTRA_ENDPOINT || undefined;

  // A non-default endpoint sourced from the committed eventra.json (not from
  // EVENTRA_ENDPOINT, which already requires a local/CI env-var change) needs
  // one-time local approval — otherwise a PR silently editing `endpoint` could
  // redirect send (and the API key) to an attacker's server.
  if (
    endpoint &&
    endpoint !== DEFAULT_SEND_ENDPOINT &&
    endpoint === config.endpoint &&
    !process.env.EVENTRA_ENDPOINT
  ) {
    const trusted = await getTrustedEndpoint();
    if (endpoint !== trusted) {
      if (!opts.trustEndpoint) {
        console.log(chalk.red(`Endpoint "${endpoint}" from eventra.json is not locally approved.`));
        console.log(
          chalk.gray(
            "If this is expected (e.g. a self-hosted ingest URL), approve it once with:",
          ),
        );
        console.log(chalk.gray("  eventra send --trust-endpoint"));
        process.exitCode = 1;
        return;
      }
      await trustEndpoint(endpoint);
      console.log(chalk.green(`Endpoint "${endpoint}" approved and saved to eventra.local.json`));
    }
  }

  let apiKey = await resolveApiKey(config);
  // ask for the key only when interactive — never hang a CI/non-TTY run on a prompt
  if (!apiKey) {
    if (!process.stdin.isTTY) {
      console.log(
        chalk.red(
          "API key required. Set the EVENTRA_API_KEY environment variable (recommended for CI) or run 'eventra init'.",
        ),
      );
      process.exitCode = 1;
      return;
    }
    const answers =
      await inquirer.prompt([
        {
          type: "input",
          name: "apiKey",
          message: "Enter your API key:"
        }
      ]);
    apiKey = answers.apiKey;
    if (apiKey) {
      // Saved to the gitignored local secrets file, never to eventra.json —
      // that file is meant to be committed for `eventra check` drift detection.
      await saveLocalApiKey(apiKey);
      console.log(chalk.green("API key saved to eventra.local.json (added to .gitignore)"));
    }
  }
  // no events
  if (!config.events?.length) {
    console.log(chalk.yellow("No events found. Run 'eventra sync'"));
    process.exitCode = 1;
    return;
  }
  if (!apiKey) {
    console.log(chalk.red("API key required"));
    process.exitCode = 1;
    return;
  }
  if (!endpoint) {
    console.log(chalk.red("Endpoint not configured"));
    process.exitCode = 1;
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
        process.exitCode = 1;
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
    process.exitCode = 1;
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
