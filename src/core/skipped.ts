import chalk from "chalk";
import path from "path";

import type { DynamicOccurrence, RejectedName } from "../analysis/shared/dynamicOccurrence";
import { TOO_DEEP_REASON, isStackOverflow } from "../filesystem/processFile";

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
  // what is left of "EACCES: permission denied, open '/the/file'" once the file's own name is taken out
  text = text.replace(/,?\s*(?:open|read|scandir|stat) ''$/, "");
  return text.replace(/\s+/g, " ").trim() || "unknown error";
}

// control characters (ESC among them, which starts a terminal escape sequence) and the invisible ones that reorder or hide
// text (zero-width, bidi overrides, line and paragraph separators)
// eslint-disable-next-line no-control-regex
const UNSAFE_TO_PRINT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Text taken from the scanned code (an event name, a resolved value, a template expression) as it is safe to put on a
 * terminal: a repository can write anything in a string, and an escape sequence in a name would be run by the terminal
 * of whoever scans it. Such characters are shown as `\n`, `\x1b` or `\u202e`.
 */
export function printable(text: string): string {
  return text.replace(UNSAFE_TO_PRINT, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    const code = char.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function skippedFrom(file: string, err: unknown): SkippedFile {
  // a call stack that ran out while reading the file: say it the way the scan does for a tree that is too deep
  if (isStackOverflow(err)) return { file, reason: TOO_DEEP_REASON };
  return { file, reason: cleanSkipReason(file, errorMessage(err)) };
}

export function formatSkipped(skipped: readonly SkippedFile[], cwd: string): string[] {
  if (skipped.length === 0) return [];
  const lines = [
    `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} that could not be analysed:`,
  ];
  for (const { file, reason } of skipped) {
    lines.push(`  ${relativeTo(cwd, file)}: ${printable(reason)}`);
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
    lines.push(`  ${relativeTo(cwd, file)}: ${printable(reason)}`);
  }
  return lines;
}

/** Prints one note (stderr) for everything ignored in a scan. */
export function reportIgnored(ignored: readonly SkippedFile[], cwd: string = process.cwd()): void {
  const lines = formatIgnored(ignored, cwd);
  if (lines.length === 0) return;
  console.error(chalk.gray(lines.join("\n")));
}

// a file name comes from the repository being scanned: it can hold an escape sequence like any string in it
const relativeTo = (cwd: string, file: string): string => printable(path.relative(cwd, file).replace(/\\/g, "/"));

/**
 * Files the parser reported a syntax error in. They are analysed all the same, so this is a heads-up,
 * not a failure: what comes after the error in such a file may not have been read.
 */
export function formatSyntaxErrors(files: readonly SkippedFile[], cwd: string): string[] {
  if (files.length === 0) return [];
  const lines = [`Syntax errors in ${files.length} file${files.length === 1 ? "" : "s"} (events after the error may be missed):`];
  for (const { file, reason } of files) {
    lines.push(`  ${relativeTo(cwd, file)}: ${printable(reason)}`);
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
    lines.push(`  ${relativeTo(cwd, file)}: ${printable(reason)}`);
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
    lines.push(`  ${where} "${printable(item.name)}": ${printable(item.reason)}`);
  }
  return lines;
}

/** Prints one note (stderr) for the event names that were seen but not added. */
export function reportRejectedNames(rejected: readonly RejectedName[], cwd: string = process.cwd()): void {
  const lines = formatRejectedNames(rejected, cwd);
  if (lines.length === 0) return;
  console.error(chalk.yellow(lines.join("\n")));
  console.error(chalk.gray("These names are not in your events. A name can use letters of any language, digits, space and $ : _ . / - [ ] ( ) # @ + & , ' (a longer one is cut to 64 characters)."));
}

/** Component files (`.vue`, `.svelte`, `.astro`) that no loaded plugin reads, with the plugin that would. */
export interface UnreadComponents {
  readonly extension: string;
  readonly plugin: string;
  readonly files: readonly string[];
}

/** Prints one note (stderr) for the component files that nothing read. */
export function reportUnreadComponents(unread: readonly UnreadComponents[], cwd: string = process.cwd()): void {
  for (const { extension, plugin, files } of unread) {
    const shown = files.slice(0, 5).map((file) => `  ${relativeTo(cwd, file)}`);
    const more = files.length > shown.length ? [`  ... and ${files.length - shown.length} more`] : [];
    console.error(
      chalk.yellow(
        [
          `${plural(files.length, `.${extension} file`)} not read: no loaded plugin handles .${extension} files, so the events in them are not in this scan.`,
          ...shown,
          ...more,
          `Install ${plugin} (npm install -D ${plugin}) and add "${plugin}" to "plugins" in eventra.json.`,
        ].join("\n"),
      ),
    );
  }
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
  /** Component files no plugin reads: their events are missing from the scan. */
  readonly unread?: readonly UnreadComponents[];
  /** `sync.include` matched no file (a typo, a moved folder): nothing was read, so "no events" means nothing. */
  readonly nothingScanned?: boolean;
  /** Files a plugin read only in part: the events in the part it left out are missing. */
  readonly partial?: readonly SkippedFile[];
}

/** Prints one note (stderr) for the files a plugin read only in part. */
export function reportPartial(partial: readonly SkippedFile[], cwd: string = process.cwd()): void {
  if (partial.length === 0) return;
  const files = new Set(partial.map((item) => item.file)).size;
  const lines = [`${files} file${files === 1 ? " was" : "s were"} read only in part (the events in what was left out are not in this scan):`];
  for (const { file, reason } of partial) lines.push(`  ${relativeTo(cwd, file)}: ${printable(reason)}`);
  console.error(chalk.yellow(lines.join("\n")));
}

/** Prints a note (stderr) when the scan found no file at all. */
export function reportNothingScanned(include: readonly string[]): void {
  console.error(chalk.yellow(`No file matched sync.include (${include.join(", ")}), so nothing was scanned. Check the patterns in eventra.json; the events it lists were kept.`));
}

const unreadCount = (problems: ScanProblems): number => (problems.unread ?? []).reduce((total, group) => total + group.files.length, 0);

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
  if (problems.nothingScanned) phrases.push("no file matched sync.include");
  add(problems.skipped.length, "skipped file", "skipped files");
  add(unreadCount(problems), "component file not read (no plugin)", "component files not read (no plugin)");
  add(new Set((problems.partial ?? []).map((item) => item.file)).size, "file read only in part", "files read only in part");
  add(problems.syntaxErrors.length, "file with a syntax error", "files with syntax errors");
  add(written(problems.rejected).length, "event name the CLI cannot accept", "event names the CLI cannot accept");
  if (!problems.dynamicDeclared) add(unresolvedDynamic(problems).length, "dynamic event name", "dynamic event names");
  add(problems.ignored.length, "file over the size limit", "files over the size limit");
  return phrases;
}

/**
 * What `--strict` fails on. Dynamic names count only when nothing could be resolved for them and the config
 * has not declared `dynamicEvents`. Files over the size limit count too: their events are not in the scan, so a
 * strict run must not call it complete. Exclude a generated file with `sync.exclude`, or raise `sync.maxFileSize`.
 */
export function hasStrictProblems(problems: ScanProblems): boolean {
  return (
    problems.nothingScanned === true ||
    problems.skipped.length > 0 ||
    unreadCount(problems) > 0 ||
    (problems.partial ?? []).length > 0 ||
    problems.syntaxErrors.length > 0 ||
    written(problems.rejected).length > 0 ||
    problems.ignored.length > 0 ||
    (!problems.dynamicDeclared && unresolvedDynamic(problems).length > 0)
  );
}
