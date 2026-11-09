import chalk from "chalk";
import path from "path";

import type { DynamicOccurrence } from "../../analysis/shared/dynamicOccurrence";
import { printable } from "../../core/skipped";
import type { PluginRegistry } from "../registry";
import type { DynamicEventReporter } from "../types";

// paths are printed relative to where the command runs, with forward slashes
function displayPath(fileName: string): string {
  const relative = path.relative(process.cwd(), fileName);
  // path.relative always joins with path.sep, so that is the only separator to look for
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`);
  const shown = relative && !outside && !path.isAbsolute(relative) ? relative : fileName;
  return shown.replace(/\\/g, "/");
}

const CAUSE_TEXT: Readonly<Record<string, string>> = {
  env: "read from the environment",
  variable: "a variable with no known value",
  template: "a template string with a part that is not known",
  call: "the result of a call",
  expression: "an expression that is not a plain value",
  callback: "a parameter of a callback given to forEach, map, an event listener and the like: its values are not in the code",
};

// `__eventraChild2_0.prototype.ButtonComponent`: how a plugin writes "the component ButtonComponent used in a template"
const COMPONENT_CALLEE = /^__eventraChild\w*\.prototype\.(\w+)$/;

/** The name of what is called, without the plugin's internal wiring. */
function calleeName(calleeText: string): string {
  const component = COMPONENT_CALLEE.exec(calleeText);
  return component ? `<${component[1]}>` : calleeText;
}

function line(occ: DynamicOccurrence, withCause: boolean): string {
  const values = occ.resolvedValues.length > 0 ? ` (resolved: ${occ.resolvedValues.map(printable).join(", ")})` : "";
  const cause = withCause && occ.cause && CAUSE_TEXT[occ.cause] ? ` [${occ.cause}: ${CAUSE_TEXT[occ.cause]}]` : "";
  const file = displayPath(occ.fileName);
  if (occ.inTemplate) {
    return `~ template of ${file}: event="${printable(occ.eventExpression ?? "")}"${values}${cause}`;
  }
  if (occ.inTemplateCode) {
    return `~ template of ${file}: ${calleeName(occ.calleeText)}(...)${values}${cause}`;
  }
  return `~ ${file}:${occ.line} ${calleeName(occ.calleeText)}(...)${values}${cause}`;
}

const consoleDynamicEventReporter: DynamicEventReporter = {
  name: "console",
  report({ occurrences: all }) {
    // the copy of a component class inside an Angular template module repeats a call the class file already reports
    const occurrences = all.filter((occ) => !occ.inGeneratedCode);
    if (occurrences.length === 0) {
      return;
    }
    // a call inside a wrapper tracks whatever each caller passes, and the callers are checked on their own;
    // it is not an event that is missing, so it is listed apart from the names that are not known where they are written
    const inWrappers = occurrences.filter((occ) => occ.kind === "wrapper");
    const unknown = occurrences.filter((occ) => occ.kind !== "wrapper");
    if (unknown.length > 0) {
      console.log(chalk.blue("\nDynamic event names:"));
      for (const occ of unknown) {
        console.log(chalk.yellow(line(occ, true)));
      }
    }
    if (inWrappers.length > 0) {
      console.log(chalk.blue("\nInside a wrapper (each caller is checked on its own):"));
      for (const occ of inWrappers) {
        console.log(chalk.gray(line(occ, false)));
      }
    }
  },
};

/** Default reporter: prints unresolved/dynamic event-name call sites to the console (always enabled). */
export function registerConsoleDynamicEventReporterPlugin(registry: PluginRegistry): void {
  registry.registerDynamicEventReporter(consoleDynamicEventReporter);
}
