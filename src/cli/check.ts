import chalk from "chalk";

import {loadConfig} from "../config/config";
import {scanProject} from "../core/projectScanner";

export async function check({fix = false}: { fix?: boolean }) {
  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    process.exit(1);
  }
  console.log(chalk.blue("Checking events...")
  );
  const {engine} = await scanProject(config);
  const found = new Set(engine.getAllEvents());
  const known = new Set(config.events ?? []);
  const added = [...found].filter(e => !known.has(e));
  const removed = [...known].filter(e => !found.has(e));
  if (fix) {
    const nextConfig = {
      ...config,
      events:
        [...found].sort(),
    };
    const {saveConfig} = await import("../config/config");
    await saveConfig(nextConfig);
    console.log(chalk.green("Synced"));
    return;
  }
  if (added.length || removed.length) {
    added.forEach(e => console.log(chalk.red(`+ ${e}`)));
    removed.forEach(e => console.log(chalk.yellow(`- ${e}`)));
    process.exit(1);
  }
  console.log(chalk.green("All good"));
}
