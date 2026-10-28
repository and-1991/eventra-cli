import chalk from "chalk";
import fs from "fs-extra";
import path from "path";

import { EventraConfig, SinkRuleConfig } from "../types";

export const CONFIG_NAME = "eventra.json";

/**
 * Secrets live here instead of `eventra.json`, since the latter is meant to be
 * committed (CI diffs `events`/`functionWrappers` against it via `eventra check`).
 */
export const LOCAL_CONFIG_NAME = "eventra.local.json";

const DEFAULT_INCLUDE = ["**/*.{ts,tsx,js,jsx}"];

// what a config without `sync.exclude` has always skipped; changing it would change the scan of every
// existing project that never wrote its own list
const DEFAULT_EXCLUDE = ["node_modules", "dist", ".next", ".git"];

/**
 * What `eventra init` writes into a new eventra.json: the default above plus folders and files whose
 * code is not the product. Events fired from a test are not features, and on a large repository the tests
 * alone can double the files scanned. Written out, so it is visible and editable. `build` and `out` are
 * left out on purpose: they are as likely to be a source folder as output.
 */
export const INIT_EXCLUDE = [
  ...DEFAULT_EXCLUDE,
  "coverage",
  "**/*.{test,spec}.{ts,tsx,js,jsx}",
  "**/__tests__/**",
  "**/__mocks__/**",
];

function normalizeSinks(sinks: unknown): SinkRuleConfig[] {
  if (!Array.isArray(sinks)) return [];
  return sinks.filter(
    (s): s is SinkRuleConfig => typeof s === "object" && s !== null && !Array.isArray(s),
  );
}

export function normalizeConfig(config: Partial<EventraConfig>): EventraConfig {
  const functionWrappers = (config.functionWrappers ?? [])
    .filter((w) => w?.name)
    .map((w) => ({ name: w.name }));

  const seen = new Set<string>();
  const uniqueWrappers = functionWrappers.filter((w) => {
    if (seen.has(w.name)) return false;
    seen.add(w.name);
    return true;
  });

  const sinks = normalizeSinks(config.sinks);

  return {
    apiKey: config.apiKey ?? "",
    endpoint: config.endpoint ?? "",
    events: [...(config.events ?? [])].sort(),
    // plain comparison, not localeCompare: the order in the committed file must
    // not depend on the machine's ICU locale
    functionWrappers: uniqueWrappers.sort((a, b) => (a.name < b.name ? -1 : 1)),
    plugins: [...(config.plugins ?? [])],
    ...(sinks.length > 0 ? { sinks } : {}),
    sync: {
      include: config.sync?.include ?? DEFAULT_INCLUDE,
      exclude: config.sync?.exclude ?? DEFAULT_EXCLUDE,
    },
  };
}

export async function loadConfig(): Promise<EventraConfig | null> {
  const configPath = path.join(process.cwd(), CONFIG_NAME);
  if (!(await fs.pathExists(configPath))) {
    return null;
  }
  try {
    const config = await fs.readJSON(configPath);
    return normalizeConfig(config);
  } catch {
    return null;
  }
}

/**
 * Says why `loadConfig` returned null, for the CLI's error message: a missing
 * file and a malformed one are different problems.
 */
export async function describeConfigProblem(): Promise<string> {
  const configPath = path.join(process.cwd(), CONFIG_NAME);
  if (!(await fs.pathExists(configPath))) return `${CONFIG_NAME} not found`;
  try {
    await fs.readJSON(configPath);
    return `${CONFIG_NAME} could not be read`;
  } catch (err) {
    // readJSON only rejects with an Error (ENOENT was ruled out above, the rest is a parse error)
    return `${CONFIG_NAME} is not valid JSON: ${(err as Error).message}`;
  }
}

/**
 * Loads the config for a command that cannot run without it. On failure it
 * prints the reason and sets a non-zero exit code, and returns null, so every
 * command ends the same way when there is no usable config.
 */
export async function requireConfig(): Promise<EventraConfig | null> {
  const config = await loadConfig();
  if (config) {
    warnInlineApiKey(config);
    return config;
  }
  console.error(await describeConfigProblem());
  process.exitCode = 1;
  return null;
}

/**
 * Tells the user when `eventra.json` holds an API key. The file is meant to be committed, so a key in it
 * is readable by everyone with access to the repository. Goes to stderr, never prints the key itself, and
 * says nothing when the field is empty (what `init` writes).
 */
export function warnInlineApiKey(config: EventraConfig): void {
  if (!config.apiKey) return;
  console.error(
    chalk.yellow(
      `${CONFIG_NAME} contains an "apiKey". This file is meant to be committed, so anyone who can read the repository can read the key.\n` +
        `Set "apiKey" to "" and use the EVENTRA_API_KEY environment variable (CI) or ${LOCAL_CONFIG_NAME} (local, gitignored) instead.\n` +
        `If the file was ever committed or pushed, create a new key in the dashboard and revoke this one.`,
    ),
  );
}

/** Writes eventra.json only when its content actually changed (watch mode re-saves often). */
export async function saveConfig(config: EventraConfig): Promise<void> {
  const configPath = path.join(process.cwd(), CONFIG_NAME);
  const next = `${JSON.stringify(normalizeConfig(config), null, 2)}\n`;
  try {
    if ((await fs.readFile(configPath, "utf8")) === next) return;
  } catch {
    // missing or unreadable: write it
  }
  await fs.writeFile(configPath, next);
}

interface LocalSecrets {
  apiKey?: string;
  trustedEndpoint?: string;
}

async function readLocalSecrets(): Promise<LocalSecrets> {
  const localPath = path.join(process.cwd(), LOCAL_CONFIG_NAME);
  if (!(await fs.pathExists(localPath))) return {};
  try {
    const parsed = await fs.readJSON(localPath);
    return {
      apiKey: typeof parsed?.apiKey === "string" && parsed.apiKey ? parsed.apiKey : undefined,
      trustedEndpoint:
        typeof parsed?.trustedEndpoint === "string" && parsed.trustedEndpoint
          ? parsed.trustedEndpoint
          : undefined,
    };
  } catch {
    return {};
  }
}

async function writeLocalSecrets(patch: LocalSecrets): Promise<void> {
  const localPath = path.join(process.cwd(), LOCAL_CONFIG_NAME);
  const next: LocalSecrets = { ...(await readLocalSecrets()), ...patch };
  const out: LocalSecrets = {};
  if (next.apiKey) out.apiKey = next.apiKey;
  if (next.trustedEndpoint) out.trustedEndpoint = next.trustedEndpoint;

  await fs.writeJSON(localPath, out, { spaces: 2 });
  await ensureGitignored(LOCAL_CONFIG_NAME);
}

async function ensureGitignored(entry: string): Promise<void> {
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  let content = "";
  if (await fs.pathExists(gitignorePath)) {
    content = await fs.readFile(gitignorePath, "utf8");
    if (content.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  }
  const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
  await fs.appendFile(gitignorePath, `${needsLeadingNewline ? "\n" : ""}${entry}\n`);
}

/**
 * Resolves the API key for outbound requests only — never persisted back onto
 * the `EventraConfig` object, so it can't leak into `eventra.json` via `saveConfig`.
 * Priority: `EVENTRA_API_KEY` env var > `eventra.local.json` (gitignored) >
 * legacy inline `apiKey` in `eventra.json` (kept for backward compatibility only).
 */
export async function resolveApiKey(config: EventraConfig): Promise<string | undefined> {
  if (process.env.EVENTRA_API_KEY) return process.env.EVENTRA_API_KEY;
  const { apiKey } = await readLocalSecrets();
  if (apiKey) return apiKey;
  return config.apiKey || undefined;
}

/** Persists an API key to the gitignored local secrets file, never to `eventra.json`. */
export async function saveLocalApiKey(apiKey: string): Promise<void> {
  await writeLocalSecrets({ apiKey });
}

/**
 * The `endpoint` a locally-run `eventra send` last approved, trust-on-first-use
 * style — a non-default `endpoint` sourced from the *committed* `eventra.json`
 * must match this before it's used, so a PR silently changing it can't redirect
 * `send` (and the API key with it) without a human approving it locally once.
 */
export async function getTrustedEndpoint(): Promise<string | undefined> {
  const { trustedEndpoint } = await readLocalSecrets();
  return trustedEndpoint;
}

/** Records `endpoint` as locally approved (see `getTrustedEndpoint`). */
export async function trustEndpoint(endpoint: string): Promise<void> {
  await writeLocalSecrets({ trustedEndpoint: endpoint });
}
