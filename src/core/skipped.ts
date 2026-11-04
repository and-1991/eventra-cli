import chalk from "chalk";
import path from "path";

import type { DynamicOccurrence, RejectedName } from "../analysis/shared/dynamicOccurrence";

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

/** What plugins said about files that is not an error: a hint, not a failure, so it never changes an exit code. */
export function formatPluginNotes(notes: readonly SkippedFile[], cwd: string): string[] {
  if (notes.length === 0) return [];
  const lines = [`Notes from plugins on ${notes.length} file${notes.length === 1 ? "" : "s"}:`];
  for (const { file, reason } of notes) {
    lines.push(`  ${relativeTo(cwd, file)}: ${reason}`);
  }
  return lines;
}

/** Prints one note (stderr) for what plugins said about files. */
export function reportPluginNotes(notes: readonly SkippedFile[], cwd: string = process.cwd()): void {
  const lines = formatPluginNotes(notes, cwd);
  if (lines.length === 0) return;
  console.error(chalk.gray(lines.join("\n")));
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
  console.error(chalk.gray("These names are not in your events. A name must not be empty or contain control characters (tab, line break)."));
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Everything a scan reported besides the events themselves. */
export interface ScanProblems {
  readonly skipped: readonly SkippedFile[];
  readonly ignored: readonly SkippedFile[];
  readonly syntaxErrors: readonly SkippedFile[];
  /** Already attributed to the user's files (PluginRegistry.attributeToSources). */
  readonly rejected: readonly RejectedName[];
  readonly dynamic: readonly DynamicOccurrence[];
  /** The config declares `dynamicEvents`: the dynamic names are known and accepted, so they are not a problem. */
  readonly dynamicDeclared?: boolean;
}

// a call copied into a generated module repeats one the user's own file already reports
const written = <T extends { readonly inGeneratedCode?: boolean }>(items: readonly T[]): T[] => items.filter((item) => !item.inGeneratedCode);

// a name with resolved values is read (the listing shows them), and a call inside a wrapper tracks what its
// callers pass, which is checked at each caller; what is left is a name that is not known where it is written
const unresolvedDynamic = (problems: ScanProblems): DynamicOccurrence[] =>
  written(problems.dynamic).filter((occurrence) => occurrence.resolvedValues.length === 0 && occurrence.kind !== "wrapper");

/**
 * One phrase per kind of problem, in the order they are reported. An empty list means the scan was clean:
 * only then may a command say that everything is fine.
 */
export function describeProblems(problems: ScanProblems): string[] {
  const phrases: string[] = [];
  const add = (count: number, singular: string, pluralForm: string): void => {
    if (count > 0) phrases.push(plural(count, singular, pluralForm));
  };
  add(problems.skipped.length, "skipped file", "skipped files");
  add(problems.syntaxErrors.length, "file with a syntax error", "files with syntax errors");
  add(written(problems.rejected).length, "event name the CLI cannot accept", "event names the CLI cannot accept");
  if (!problems.dynamicDeclared) add(unresolvedDynamic(problems).length, "dynamic event name", "dynamic event names");
  add(problems.ignored.length, "file over the size limit", "files over the size limit");
  return phrases;
}

/**
 * What `--strict` fails on. Dynamic names count only when nothing could be resolved for them and the config
 * has not declared `dynamicEvents`, and files
 * over the size limit are a deliberate choice, not a failure: see formatIgnored.
 */
export function hasStrictProblems(problems: ScanProblems): boolean {
  return (
    problems.skipped.length > 0 ||
    problems.syntaxErrors.length > 0 ||
    written(problems.rejected).length > 0 ||
    (!problems.dynamicDeclared && unresolvedDynamic(problems).length > 0)
  );
}
