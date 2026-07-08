import fs from "fs-extra";
import path from "path";

import { EventraConfig } from "../types";

export const CONFIG_NAME = "eventra.json";

/**
 * Secrets live here instead of `eventra.json`, since the latter is meant to be
 * committed (CI diffs `events`/`functionWrappers` against it via `eventra check`).
 */
export const LOCAL_CONFIG_NAME = "eventra.local.json";

const DEFAULT_INCLUDE = ["**/*.{ts,tsx,js,jsx}"];

const DEFAULT_EXCLUDE = ["node_modules", "dist", ".next", ".git"];

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

  return {
    apiKey: config.apiKey ?? "",
    endpoint: config.endpoint ?? "",
    events: [...(config.events ?? [])].sort(),
    functionWrappers: uniqueWrappers.sort((a, b) => a.name.localeCompare(b.name)),
    plugins: [...(config.plugins ?? [])],
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

export async function saveConfig(config: EventraConfig): Promise<void> {
  const configPath = path.join(process.cwd(), CONFIG_NAME);
  await fs.writeJSON(configPath, normalizeConfig(config), { spaces: 2 });
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
