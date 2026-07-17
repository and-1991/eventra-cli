import chalk from "chalk";

import { loadConfig } from "../config/config";
import { scanProject } from "../core/projectScanner";
import { persistScanResults } from "../core/scanResults";

export async function sync(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    return;
  }
  console.log(chalk.blue("Scanning..."));
  const { engine, plugins } = await scanProject(config);
  await persistScanResults(config, engine);
  const events = engine.getAllEvents();
  const wrappers = engine.getAllFunctionWrappers();
  console.log(chalk.green(`Found ${events.length} events, ${wrappers.length} function wrappers`));
  await plugins.runDynamicEventReporters(engine.getAllDynamicOccurrences());
}
