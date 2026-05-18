import chalk from "chalk";

import { loadConfig, saveConfig } from "../config/config";
import { scanProject } from "../core/projectScanner";
import { buildConfigFromScan } from "../core/scanResults";

function diffSets(found: Set<string>, known: Set<string>): { added: string[]; removed: string[] } {
  return {
    added: [...found].filter((e) => !known.has(e)),
    removed: [...known].filter((e) => !found.has(e)),
  };
}

export async function check({ fix = false }: { fix?: boolean }) {
  const config = await loadConfig();
  if (!config) {
    console.log(chalk.red("eventra.json not found"));
    process.exit(1);
  }
  console.log(chalk.blue("Checking events and function wrappers..."));
  const { engine } = await scanProject(config);

  const foundEvents = new Set(engine.getAllEvents());
  const knownEvents = new Set(config.events ?? []);
  const eventDiff = diffSets(foundEvents, knownEvents);

  const foundWrappers = new Set(engine.getAllFunctionWrappers());
  const knownWrappers = new Set(config.functionWrappers?.map((w) => w.name) ?? []);
  const wrapperDiff = diffSets(foundWrappers, knownWrappers);

  if (fix) {
    await saveConfig(buildConfigFromScan(config, engine));
    console.log(chalk.green("Synced"));
    return;
  }

  let hasDiff = false;

  if (eventDiff.added.length || eventDiff.removed.length) {
    hasDiff = true;
    console.log(chalk.blue("\nEvents:"));
    eventDiff.added.forEach((e) => console.log(chalk.red(`+ ${e}`)));
    eventDiff.removed.forEach((e) => console.log(chalk.yellow(`- ${e}`)));
  }

  if (wrapperDiff.added.length || wrapperDiff.removed.length) {
    hasDiff = true;
    console.log(chalk.blue("\nFunction wrappers:"));
    wrapperDiff.added.forEach((w) => console.log(chalk.red(`+ ${w}`)));
    wrapperDiff.removed.forEach((w) => console.log(chalk.yellow(`- ${w}`)));
  }

  if (hasDiff) {
    process.exit(1);
  }
  console.log(chalk.green("All good"));
}
