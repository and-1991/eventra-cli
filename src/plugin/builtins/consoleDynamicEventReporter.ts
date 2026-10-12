import chalk from "chalk";
import path from "path";

import type { PluginRegistry } from "../registry";
import type { DynamicEventReporter } from "../types";

// paths are printed relative to where the command runs, with forward slashes
function displayPath(fileName: string): string {
  const relative = path.relative(process.cwd(), fileName);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || relative.startsWith("../");
  const shown = relative && !outside && !path.isAbsolute(relative) ? relative : fileName;
  return shown.replace(/\\/g, "/");
}

const consoleDynamicEventReporter: DynamicEventReporter = {
  name: "console",
  report({ occurrences: all }) {
    // the copy of a component class inside an Angular template module repeats a call the class file already reports
    const occurrences = all.filter((occ) => !occ.inGeneratedCode);
    if (occurrences.length === 0) {
      return;
    }
    console.log(chalk.blue("\nDynamic event names:"));
    for (const occ of occurrences) {
      const values = occ.resolvedValues.length > 0 ? ` (resolved: ${occ.resolvedValues.join(", ")})` : "";
      const file = displayPath(occ.fileName);
      if (occ.inTemplate) {
        console.log(chalk.yellow(`~ template of ${file}: event="${occ.eventExpression ?? ""}"${values}`));
      } else {
        console.log(chalk.yellow(`~ ${file}:${occ.line} ${occ.calleeText}(...)${values}`));
      }
    }
  },
};

/** Default reporter: prints unresolved/dynamic event-name call sites to the console (always enabled). */
export function registerConsoleDynamicEventReporterPlugin(registry: PluginRegistry): void {
  registry.registerDynamicEventReporter(consoleDynamicEventReporter);
}
