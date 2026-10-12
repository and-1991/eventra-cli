import chalk from "chalk";
import path from "path";

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

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
