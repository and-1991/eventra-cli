import chalk from "chalk";

import { normalizeDynamicEvents } from "../analysis/sdk/eventraSdk";
import { requireConfig } from "../config/config";
import { scanProject } from "../core/projectScanner";
import { persistScanResults } from "../core/scanResults";
import { describeProblems, hasStrictProblems, plural, reportIgnored, reportPluginNotes, reportRejectedNames, reportNothingScanned, reportPartial, reportSkipped, reportSyntaxErrors, reportUnreadComponents } from "../core/skipped";

export async function sync({ strict = false }: { strict?: boolean } = {}): Promise<void> {
  const config = await requireConfig();
  if (!config) return;
  console.log(chalk.blue("Scanning..."));
  const { engine, plugins, skipped, ignored, syntaxErrors, unread, partial, files, notes: pluginNotes } = await scanProject(config);
  const nothingScanned = files.length === 0;
  // report what was saved: with skipped files that is the union of the known and
  // the found events, not just what this scan found
  const saved = await persistScanResults(config, engine, { preserveKnown: skipped.length > 0 || unread.length > 0 || partial.length > 0 || nothingScanned });
  // normalizeConfig always fills functionWrappers; the type only marks it optional
  /* v8 ignore next */
  const wrapperCount = saved.functionWrappers?.length ?? 0;
  console.log(
    chalk.green(`Found ${plural(saved.events.length, "event")}, ${plural(wrapperCount, "function wrapper")}`),
  );
  const dynamic = engine.getAllDynamicOccurrences();
  await plugins.runDynamicEventReporters(dynamic);
  const rejected = plugins.attributeToSources(engine.getAllRejectedNames());
  if (nothingScanned) reportNothingScanned(config.sync.include);
  reportSkipped(skipped);
  reportUnreadComponents(unread);
  reportPartial(partial);
  reportIgnored(ignored);
  reportSyntaxErrors(syntaxErrors);
  reportRejectedNames(rejected);
  reportPluginNotes(pluginNotes);
  const problems = { skipped, ignored, syntaxErrors, rejected, dynamic, unread, partial, nothingScanned, dynamicDeclared: normalizeDynamicEvents(config.dynamicEvents).length > 0 };
  const notes = describeProblems(problems);
  if (notes.length > 0) console.error(chalk.yellow(`The scan was not clean: ${notes.join(", ")}.`));
  if (strict && hasStrictProblems(problems)) process.exitCode = 1;
}
