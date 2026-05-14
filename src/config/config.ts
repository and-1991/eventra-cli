import fs from "fs-extra";
import path from "path";

import {EventraConfig,} from "../types";

export const CONFIG_NAME = "eventra.json";

const DEFAULT_INCLUDE = ["**/*.{ts,tsx,js,jsx}"];

const DEFAULT_EXCLUDE = ["node_modules", "dist", ".next", ".git"];

export function normalizeConfig(config: Partial<EventraConfig>): EventraConfig {

  return {
    apiKey: config.apiKey ?? "",
    endpoint: config.endpoint ?? "",
    events: config.events ?? [],
    sync: {
      include: config.sync?.include ?? DEFAULT_INCLUDE,
      exclude: config.sync?.exclude ?? DEFAULT_EXCLUDE,
    },
  };
}

export async function loadConfig(): Promise<EventraConfig | null> {
  const configPath = path.join(process.cwd(), CONFIG_NAME);
  if (!await fs.pathExists(configPath)) {
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

  await fs.writeJSON(configPath, normalizeConfig(config), {spaces: 2});
}
