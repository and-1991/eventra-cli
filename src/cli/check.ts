import chalk from "chalk";

import { requireConfig, saveConfig } from "../config/config";
import { scanProject } from "../core/projectScanner";
import { buildConfigFromScan } from "../core/scanResults";
import { plural, reportIgnored, reportRejectedNames, reportSkipped, reportSyntaxErrors } from "../core/skipped";

function diffSets(found: Set<string>, known: Set<string>): { added: string[]; removed: string[] } {
  return {
    added: [...found].filter((e) => !known.has(e)),
    removed: [...known].filter((e) => !found.has(e)),
  };
}

export async function check({ fix = false, strict = false }: { fix?: boolean; strict?: boolean } = {}) {
  const config = await requireConfig();
  if (!config) return;
  console.log(chalk.blue("Checking events and function wrappers..."));
  const { engine, plugins, skipped, ignored, syntaxErrors } = await scanProject(config);
  const reportNotes = (): void => {
    reportSyntaxErrors(syntaxErrors);
    reportRejectedNames(plugins.attributeToSources(engine.getAllRejectedNames()));
  };
  await plugins.runDynamicEventReporters(engine.getAllDynamicOccurrences());
  const partial = skipped.length > 0;

  const foundEvents = new Set(engine.getAllEvents());
  const knownEvents = new Set(config.events ?? []);
  const eventDiff = diffSets(foundEvents, knownEvents);

  const foundWrappers = new Set(engine.getAllFunctionWrappers());
  const knownWrappers = new Set(config.functionWrappers?.map((w) => w.name) ?? []);
  const wrapperDiff = diffSets(foundWrappers, knownWrappers);

  // With skipped files the scan is incomplete: a known event that was not found
  // may simply live in a skipped file, so it is not reported as removed.
  const unverified = partial ? eventDiff.removed.length + wrapperDiff.removed.length : 0;
  if (partial) {
    eventDiff.removed = [];
    wrapperDiff.removed = [];
  }

  if (fix) {
    await saveConfig(buildConfigFromScan(config, engine, { preserveKnown: partial }));
    console.log(chalk.green("Synced"));
    reportSkipped(skipped);
    reportIgnored(ignored);
    reportNotes();
    if (strict && partial) process.exitCode = 1;
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

  reportSkipped(skipped);
  reportIgnored(ignored);
  reportNotes();
  if (unverified > 0) {
    console.error(
      chalk.gray(`${plural(unverified, "known entry", "known entries")} could not be verified because files were skipped.`),
    );
  }

  if (hasDiff || (strict && partial)) {
    process.exit(1);
  }
  console.log(chalk.green("All good"));
}
