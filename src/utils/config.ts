import fs from "fs-extra";
import path from "path";
import { EventraConfig } from "../types";

export const CONFIG_NAME = "eventra.json";

export function normalizeConfig(
  config: Partial<EventraConfig>
): EventraConfig {
  return {
    apiKey: config.apiKey ?? "",
    events: config.events ?? [],
    wrappers: config.wrappers ?? [],
    functionWrappers:
      config.functionWrappers ?? [],
    sync: config.sync ?? {
      include: [
        "**/*.{ts,tsx,js,jsx}"
      ],
      exclude: [
        "node_modules",
        "dist",
        ".next",
        ".git"
      ]
    }
  };
}

export async function loadConfig(): Promise<EventraConfig | null> {
  const configPath = path.join(
    process.cwd(),
    CONFIG_NAME
  );

  if (
    !(await fs.pathExists(
      configPath
    ))
  ) {
    return null;
  }

  const config =
    await fs.readJSON(
      configPath
    );

  return normalizeConfig(config);
}

export async function saveConfig(
  config: EventraConfig
) {
  const configPath = path.join(
    process.cwd(),
    CONFIG_NAME
  );

  const normalized =
    normalizeConfig(config);

  await fs.writeJSON(
    configPath,
    normalized,
    {
      spaces: 2
    }
  );
}
