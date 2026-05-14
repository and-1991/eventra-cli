import chalk from "chalk";

import {loadConfig, saveConfig} from "../config/config";
import {scanProject} from "../core/projectScanner";

export async function sync(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    return;
  }
  console.log(chalk.blue("Scanning..."));
  const {engine} = await scanProject(config);
  const events = engine.getAllEvents().sort();
  await saveConfig({...config, events});
  console.log(chalk.green(`Found ${events.length} events`),
  );
}
