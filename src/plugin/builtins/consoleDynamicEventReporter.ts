import chalk from "chalk";

import type { PluginRegistry } from "../registry";
import type { DynamicEventReporter } from "../types";

const consoleDynamicEventReporter: DynamicEventReporter = {
  name: "console",
  report({ occurrences }) {
    if (occurrences.length === 0) {
      return;
    }
    console.log(chalk.blue("\nDynamic event names:"));
    for (const occ of occurrences) {
      const values = occ.resolvedValues.length > 0 ? ` (resolved: ${occ.resolvedValues.join(", ")})` : "";
      console.log(chalk.yellow(`~ ${occ.fileName}:${occ.line} ${occ.calleeText}(...)${values}`));
    }
  },
};

/** Default reporter: prints unresolved/dynamic event-name call sites to the console (always enabled). */
export function registerConsoleDynamicEventReporterPlugin(registry: PluginRegistry): void {
  registry.registerDynamicEventReporter(consoleDynamicEventReporter);
}
