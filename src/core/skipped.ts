import chalk from "chalk";
import path from "path";

import type { RejectedName } from "../analysis/shared/dynamicOccurrence";

export interface SkippedFile {
  readonly file: string;
  readonly reason: string;
}

/**
 * A skipped file's error is wrapped once by the CLI, once by the plugin
 * adapter and once by the plugin itself, each repeating the path. Keep only the
 * innermost message.
 */
export function cleanSkipReason(file: string, message: string): string {
  let text = message.split(file).join("").trim();
  text = text.replace(/^Plugin "[^"]*" failed to transform\s*:\s*/, "");
  text = text.replace(/^Failed to parse [A-Za-z][A-Za-z ]*?\s*:\s*/, "");
  return text.replace(/\s+/g, " ").trim() || "unknown error";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function skippedFrom(file: string, err: unknown): SkippedFile {
  return { file, reason: cleanSkipReason(file, errorMessage(err)) };
}

export function formatSkipped(skipped: readonly SkippedFile[], cwd: string): string[] {
  if (skipped.length === 0) return [];
  const lines = [
    `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} that could not be analysed:`,
  ];
  for (const { file, reason } of skipped) {
    lines.push(`  ${path.relative(cwd, file).replace(/\\/g, "/")}: ${reason}`);
  }
  return lines;
}

/** Prints one summary block (stderr) for everything skipped in a scan. */
export function reportSkipped(skipped: readonly SkippedFile[], cwd: string = process.cwd()): void {
  const lines = formatSkipped(skipped, cwd);
  if (lines.length === 0) return;
  console.error(chalk.yellow(lines.join("\n")));
  console.error(
    chalk.gray("Events from these files are not in this scan; previously known events were kept. Use --strict to fail on skipped files."),
  );
}

/**
 * Files that were deliberately not analysed (for example generated bundles
 * over the size limit). Unlike skipped files they are not failures: their
 * absence neither keeps known events nor makes a catalog snapshot incomplete.
 */
export function formatIgnored(ignored: readonly SkippedFile[], cwd: string): string[] {
  if (ignored.length === 0) return [];
  const lines = [
    `Ignored ${ignored.length} file${ignored.length === 1 ? "" : "s"} (not analysed):`,
  ];
  for (const { file, reason } of ignored) {
    lines.push(`  ${path.relative(cwd, file).replace(/\\/g, "/")}: ${reason}`);
  }
  return lines;
}

/** Prints one note (stderr) for everything ignored in a scan. */
export function reportIgnored(ignored: readonly SkippedFile[], cwd: string = process.cwd()): void {
  const lines = formatIgnored(ignored, cwd);
  if (lines.length === 0) return;
  console.error(chalk.gray(lines.join("\n")));
}

const relativeTo = (cwd: string, file: string): string => path.relative(cwd, file).replace(/\\/g, "/");

/**
 * Files the parser reported a syntax error in. They are analysed all the same, so this is a heads-up,
 * not a failure: what comes after the error in such a file may not have been read.
 */
export function formatSyntaxErrors(files: readonly SkippedFile[], cwd: string): string[] {
  if (files.length === 0) return [];
  const lines = [`Syntax errors in ${files.length} file${files.length === 1 ? "" : "s"} (events after the error may be missed):`];
  for (const { file, reason } of files) {
    lines.push(`  ${relativeTo(cwd, file)}: ${reason}`);
  }
  return lines;
}

/** Prints one note (stderr) for the files that have syntax errors. */
export function reportSyntaxErrors(files: readonly SkippedFile[], cwd: string = process.cwd()): void {
  const lines = formatSyntaxErrors(files, cwd);
  if (lines.length === 0) return;
  console.error(chalk.yellow(lines.join("\n")));
}

/**
 * Event names the CLI read as plain text but cannot accept. `rejected` must already be attributed to the
 * files the user wrote (PluginRegistry.attributeToSources), so a template is named, not its generated module.
 */
export function formatRejectedNames(rejected: readonly RejectedName[], cwd: string): string[] {
  // the copy of a component class inside an Angular template module repeats a call the class file already reports
  const shown = rejected.filter((item) => !item.inGeneratedCode);
  if (shown.length === 0) return [];
  const lines = [`Skipped ${shown.length} event name${shown.length === 1 ? "" : "s"} the CLI cannot accept:`];
  for (const item of shown) {
    const file = relativeTo(cwd, item.fileName);
    const where = item.inTemplate || item.inTemplateCode ? `template of ${file}` : `${file}:${item.line}`;
    lines.push(`  ${where} "${item.name}": ${item.reason}`);
  }
  return lines;
}

/** Prints one note (stderr) for the event names that were seen but not added. */
export function reportRejectedNames(rejected: readonly RejectedName[], cwd: string = process.cwd()): void {
  const lines = formatRejectedNames(rejected, cwd);
  if (lines.length === 0) return;
  console.error(chalk.yellow(lines.join("\n")));
  console.error(chalk.gray("These names are not in your events. A name can use letters, digits and $ : _ . / - and space, up to 64 characters."));
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
