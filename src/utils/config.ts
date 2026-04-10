import fs from "fs-extra";
import path from "path";

export const CONFIG_NAME = "eventra.json";

export function normalizeConfig(config: any) {
  return {
    apiKey: config.apiKey ?? "",
    events: config.events ?? [],
    wrappers: config.wrappers ?? [],
    sync: config.sync ?? {
      include: ["**/*.{ts,tsx,js,jsx}"],
      exclude: [
        "node_modules",
        "dist",
        ".next",
        ".git"
      ]
    }
  };
}

export async function loadConfig() {
  const configPath = path.join(
    process.cwd(),
    CONFIG_NAME
  );

  if (!(await fs.pathExists(configPath))) {
    return null;
  }

  const config = await fs.readJSON(configPath);

  return normalizeConfig(config);
}

export async function saveConfig(config: any) {
  const configPath = path.join(
    process.cwd(),
    CONFIG_NAME
  );

  const normalized = normalizeConfig(config);

  await fs.writeJSON(
    configPath,
    normalized,
    {
      spaces: 2
    }
  );
}
