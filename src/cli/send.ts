import chalk from "chalk";
import inquirer from "inquirer";

import {getTrustedEndpoint, loadConfig, resolveApiKey, saveLocalApiKey, trustEndpoint, warnInlineApiKey} from "../config/config";
import { collectCatalogMeta } from "../core/catalogMeta";
import pkg from "../../package.json";

const CLI_VERSION = pkg.version;

// Always trusted, no local approval needed — matches `eventra init`'s prompt default.
const DEFAULT_SEND_ENDPOINT = "https://api.eventra.dev/api/v1/cli/events";

// The API key travels with every request. Plain http is fine for a local
// ingest server (loopback) and is allowed elsewhere with a warning, since
// self-hosted setups in a container or a private network legitimately use it.
// Anything that is not an http(s) URL is refused.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type EndpointCheck = "secure" | "insecure" | "invalid";

export function checkEndpoint(endpoint: string): EndpointCheck {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "invalid";
  }
  if (url.protocol === "https:") return "secure";
  if (url.protocol !== "http:") return "invalid";
  return LOOPBACK_HOSTS.has(url.hostname) ? "secure" : "insecure";
}

// fetch reports `redirect: "error"` as a TypeError "fetch failed" whose cause is
// "unexpected redirect"
export function isRedirectError(err: unknown): boolean {
  const cause = (err as { cause?: { message?: unknown } } | null)?.cause;

  return typeof cause?.message === "string" && /redirect/i.test(cause.message);
}

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
      // never follow a redirect: x-api-key is a custom header, so fetch would
      // forward it to wherever a compromised or misconfigured server points
      redirect: "error",
    });

    if (res.ok) {
      // a 2xx is delivered whatever the body is: a 204, an empty body or a proxy's text must not turn into a
      // "failure" that retries and posts the same payload again
      let data: SendResponse = {};
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as SendResponse;
      } catch {
        /* not JSON: still delivered */
      }
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

// the API answers a rejected unknown property with {"error":{"code":"VALIDATION_ERROR",...}}
/** `fetch failed` says nothing; the reason (ECONNREFUSED, ENOTFOUND, a certificate) is on its `cause`. */
export function describeFetchError(err: Error): string {
  const cause = (err as Error & { cause?: { code?: unknown; message?: unknown } }).cause;
  const reason = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : undefined;
  return reason && !err.message.includes(reason) ? `${err.message} (${reason})` : err.message;
}

function isValidationError(body: string | undefined): boolean {
  // either the API's own code, or the wording of a validator that refuses a property it does not know
  return typeof body === "string" && (body.includes("VALIDATION_ERROR") || /should not exist|unknown property|additional propert/i.test(body));
}

type SendResponse = {
  created?: string[];
  existing?: string[];
};

export async function send(opts: { trustEndpoint?: boolean } = {}) {
  const config = await loadConfig();
  if (!config) {
    console.error(chalk.red("eventra.json not found. Run 'eventra init'"));
    process.exitCode = 1;
    return;
  }
  warnInlineApiKey(config);

  // EVENTRA_ENDPOINT wins over eventra.json. It is set in the local or CI
  // environment, which a PR cannot change. The committed file is the one an
  // attacker can edit, so it is only used when the variable is absent and then
  // needs approval below. (It used to win, and the approval was skipped
  // whenever the variable was set, so a PR could redirect a CI send.)
  const envEndpoint = process.env.EVENTRA_ENDPOINT || undefined;
  const endpoint = envEndpoint || config.endpoint || undefined;

  // A non-default endpoint sourced from the committed eventra.json needs
  // one-time local approval — otherwise a PR silently editing `endpoint` could
  // redirect send (and the API key) to an attacker's server.
  if (
    endpoint &&
    endpoint !== DEFAULT_SEND_ENDPOINT &&
    endpoint === config.endpoint &&
    !envEndpoint
  ) {
    const trusted = await getTrustedEndpoint();
    if (endpoint !== trusted) {
      if (!opts.trustEndpoint) {
        console.error(chalk.red(`Endpoint "${endpoint}" from eventra.json is not locally approved.`));
        console.error(
          chalk.gray(
            "If this is expected (e.g. a self-hosted ingest URL), approve it once with:",
          ),
        );
        console.error(chalk.gray("  eventra send --trust-endpoint"));
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
      console.error(
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
          type: "password",
          name: "apiKey",
          mask: "*",
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
    console.error(chalk.yellow("No events found. Run 'eventra sync'"));
    process.exitCode = 1;
    return;
  }
  if (!apiKey) {
    console.error(chalk.red("API key required"));
    process.exitCode = 1;
    return;
  }
  // a key pasted with a space or a line break around it is the key: trimmed, not refused
  apiKey = apiKey.trim();
  // a key goes into an HTTP header: anything but printable ASCII makes fetch refuse it, which used to be retried
  // four times as a "network error"
  if (/[^\x21-\x7e]/.test(apiKey)) {
    console.error(chalk.red("The API key has characters that cannot be sent (spaces, accents, other alphabets). Copy it again from the dashboard."));
    process.exitCode = 1;
    return;
  }
  if (!endpoint) {
    console.error(chalk.red("Endpoint not configured"));
    process.exitCode = 1;
    return;
  }
  const endpointCheck = checkEndpoint(endpoint);
  if (endpointCheck === "invalid") {
    console.error(chalk.red(`Endpoint "${endpoint}" is not a valid http(s) URL.`));
    process.exitCode = 1;
    return;
  }
  if (endpointCheck === "insecure") {
    console.log(
      chalk.yellow(`Warning: "${endpoint}" uses plain http, so the API key is sent unencrypted. Use https unless this is a trusted private network.`),
    );
  }
  console.log("");
  console.log(chalk.blue(`Sending ${config.events.length} events...`));

  // Tells the server whether this list is a full snapshot of the code (so names
  // missing from it can be marked as removed) and how many event names could
  // not be resolved. Older servers ignore the extra fields.
  const meta = await collectCatalogMeta(config);
  if (!meta.complete) {
    console.log(
      chalk.gray(
        "Catalog snapshot marked incomplete (files were skipped, the scan failed, or eventra.json is out of date: run 'eventra sync')",
      ),
    );
  }

  const legacyBody = {
    events: config.events,
    cli: {
      name: "@eventra_dev/eventra-cli",
      version: CLI_VERSION,
      runtime: "node",
    },
  };
  const payload = JSON.stringify({
    ...legacyBody,
    complete: meta.complete,
    cliVersion: CLI_VERSION,
    ...(meta.dynamicCount !== undefined ? { dynamicCount: meta.dynamicCount } : {}),
    ...(meta.branch ? { branch: meta.branch } : {}),
  });
  // A server that predates the catalog fields rejects unknown properties with a
  // generic validation 400; the request is then repeated once without them.
  const legacyPayload = JSON.stringify(legacyBody);
  let body = payload;

  // attempt delivery with retry on 429/5xx/network errors
  let data: SendResponse | undefined;
  let lastFailure: { status?: number; body?: string; error?: unknown } | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const outcome = await attemptDelivery(endpoint, apiKey, body);

      if (outcome.ok) {
        data = outcome.data;
        break;
      }

      if (outcome.status === 400 && body !== legacyPayload && isValidationError(outcome.body)) {
        body = legacyPayload;
        console.log(chalk.gray("Server does not know the catalog fields yet, sending the plain event list"));
        attempt--;
        continue;
      }

      if (!outcome.retryable) {
        // permanent failure — surface immediately
        console.error(chalk.red(`Request failed (${outcome.status})`));
        if (outcome.body) console.error(chalk.gray(outcome.body));
        if (outcome.status === 403 && outcome.body?.includes("not valid for this endpoint")) {
          console.log(
            chalk.yellow(
              "This API key was created for the SDK. Create a key with CLI access under the project's API keys in the dashboard and use it as EVENTRA_API_KEY.",
            ),
          );
        }
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
      // a redirect is an answer, not a glitch: it is never followed (the API key
      // would go along), and retrying would only get the same answer
      if (isRedirectError(err)) {
        console.error(chalk.red(`The endpoint "${endpoint}" answered with a redirect. send does not follow redirects, because they could forward your API key.`));
        console.error(chalk.gray("Use the final URL as the endpoint (for example the https address, or the one without or with the trailing slash)."));
        process.exitCode = 1;
        return;
      }

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
    console.error(chalk.red("All retries exhausted"));
    if (lastFailure?.status) {
      console.error(chalk.gray(`Last status: ${lastFailure.status}`));
      if (lastFailure.body) console.error(chalk.gray(lastFailure.body));
    } else if (lastFailure?.error instanceof Error) {
      // an aborted request is the 10 second limit, not a mystery
      const aborted = lastFailure.error.name === "AbortError" || lastFailure.error.name === "TimeoutError";
      console.error(chalk.gray(aborted ? `The server did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds.` : describeFetchError(lastFailure.error)));
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
