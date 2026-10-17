import chalk from "chalk";

import { requireConfig } from "../config/config";
import { scanProject } from "../core/projectScanner";
import { persistScanResults } from "../core/scanResults";
import { plural, reportIgnored, reportSkipped } from "../core/skipped";

export async function sync({ strict = false }: { strict?: boolean } = {}): Promise<void> {
  const config = await requireConfig();
  if (!config) return;
  console.log(chalk.blue("Scanning..."));
  const { engine, plugins, skipped, ignored } = await scanProject(config);
  // report what was saved: with skipped files that is the union of the known and
  // the found events, not just what this scan found
  const saved = await persistScanResults(config, engine, { preserveKnown: skipped.length > 0 });
  // normalizeConfig always fills functionWrappers; the type only marks it optional
  /* v8 ignore next */
  const wrapperCount = saved.functionWrappers?.length ?? 0;
  console.log(
    chalk.green(`Found ${plural(saved.events.length, "event")}, ${plural(wrapperCount, "function wrapper")}`),
  );
  await plugins.runDynamicEventReporters(engine.getAllDynamicOccurrences());
  reportSkipped(skipped);
  reportIgnored(ignored);
  if (strict && skipped.length > 0) process.exitCode = 1;
}
