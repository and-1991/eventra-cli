import { listFiles } from "./listFiles";
import fs from "fs/promises";
import path from "path";

import { EventraConfig, ScanResult } from "../types";
import { EVENTRA_SDK_SHIM } from "../analysis/sdk/eventraSdk";
import { EventraEngine } from "./EventraEngine";
import { MAX_AST_DEPTH, TOO_DEEP_REASON, processFile, type ProcessedFile } from "../filesystem/processFile";
import { getVirtualFile } from "../filesystem/getVirtualFile";
import { createPluginRegistry } from "../plugin/loadPlugins";
import type { PluginRegistry } from "../plugin/registry";
import { expandExcludePatterns, withDefaultExcludes } from "./scanFilters";
import { type SkippedFile, type UnreadComponents, skippedFrom } from "./skipped";
import { fileLimit, isOversized, oversizedReason } from "./fileLimits";

const SDK_TYPES_FILE = "__eventra_sdk_types__.d.ts";

interface CachedFile {
  readonly content: string;
  readonly dependencies: readonly string[];
}

export interface ProjectScanResult {
  readonly engine: EventraEngine;
  readonly results: Map<string, ScanResult>;
  readonly files: readonly string[];
  readonly plugins: PluginRegistry;
  /** Files that could not be analysed, with the reason; their events are missing from `results`. */
  readonly skipped: readonly SkippedFile[];
  /** Files deliberately not analysed (over the size limit). Not failures: see formatIgnored. */
  readonly ignored: readonly SkippedFile[];
  /** What plugins said about files that is not an error (a binding Angular rejects, say), by file. Not a failure. */
  readonly notes: readonly SkippedFile[];
  /** Files the parser reported a syntax error in. They are still analysed; events after the error may be missed. */
  readonly syntaxErrors: readonly SkippedFile[];
  /** `.vue`, `.svelte` and `.astro` files in scope that no plugin reads: their events are not in the scan. */
  readonly unread: readonly UnreadComponents[];
  /** Files a plugin read only in part (a template too large for its compiler): some of their events are missing. */
  readonly partial: readonly SkippedFile[];
}

const COMPONENT_PLUGINS: Readonly<Record<string, string>> = {
  vue: "@eventra_dev/cli-plugin-vue",
  svelte: "@eventra_dev/cli-plugin-svelte",
  astro: "@eventra_dev/cli-plugin-astro",
};

const COMPONENT_EXTENSION = /\.(?:vue|svelte|astro)$/i;

/**
 * The syntax error of a file's (virtual) module that is the user's. A plain file reports its syntax errors. A module a
 * plugin generated does too, when the line is code the user wrote (a script); code the plugin generated from a template
 * is valid by construction, and an Angular template module repeats its component class. Plugins keep the lines of the
 * original file.
 */
export function syntaxErrorOf(file: string, moduleName: string, parsed: ProcessedFile, plugins: PluginRegistry): SkippedFile | undefined {
  const error = parsed.syntaxError;
  if (!error) return undefined;
  // an Angular template module is built by the plugin from the HTML, which reports its own errors
  if (moduleName !== file && moduleName.toLowerCase().endsWith(".html.ts")) return undefined;
  if (moduleName === file || plugins.isUserWrittenLine(moduleName, error.line)) {
    return { file, reason: `line ${error.line}: ${error.message}` };
  }
  // In the part a plugin builds from the template the line is the module's, not the file's, so it is
  // not shown. The expressions there are copied as the user wrote them: a broken one (an Astro
  // `onclick={() => track("x"}`, which the Astro compiler lets through) used to go unreported.
  return { file, reason: `the code built from the template does not parse (${error.message}): check the expressions in the template` };
}

/** The plugin that would read a component file nothing reads, or undefined when the file is not one or something reads it. */
export function unreadComponentFor(file: string, plugins: PluginRegistry): UnreadComponents | undefined {
  if (!COMPONENT_EXTENSION.test(file) || plugins.getFilePreprocessors().some((preprocessor) => preprocessor.test(file))) return undefined;
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return { extension, plugin: COMPONENT_PLUGINS[extension], files: [file] };
}

/**
 * Component files the scan cannot see because no loaded plugin handles them. Looked for wherever a plugin would
 * have looked (a plugin's globs are not narrowed by `sync.include`, only by `sync.exclude`), and never reported
 * when a plugin does handle the file, so a project that has its plugins sees nothing.
 */
export async function findUnreadComponents(config: EventraConfig, plugins: PluginRegistry): Promise<UnreadComponents[]> {
  const preprocessors = plugins.getFilePreprocessors();
  const found = await listFiles([`**/*.{${Object.keys(COMPONENT_PLUGINS).join(",")}}`], expandExcludePatterns(withDefaultExcludes(config.sync.exclude)));
  const unread: UnreadComponents[] = [];
  for (const [extension, plugin] of Object.entries(COMPONENT_PLUGINS)) {
    const files = found.filter((file) => file.endsWith(`.${extension}`) && !preprocessors.some((preprocessor) => preprocessor.test(file))).sort();
    if (files.length > 0) unread.push({ extension, plugin, files });
  }
  return unread;
}

export async function scanProject(config: EventraConfig): Promise<ProjectScanResult> {
  const plugins = await createPluginRegistry(config);
  const include = [...config.sync.include, ...plugins.getIncludePatterns()];

  const files = await listFiles(include, expandExcludePatterns(withDefaultExcludes(config.sync.exclude)));

  const engine = new EventraEngine(process.cwd(), plugins);
  const cache = new Map<string, CachedFile>();
  const toScan = new Set<string>();
  const skipped: SkippedFile[] = [];
  const ignored: SkippedFile[] = [];
  const syntaxErrors: SkippedFile[] = [];
  const limit = fileLimit(config.sync.maxFileSize);

  for (const file of files) {
    // a component file in `include` with no plugin for it is not TypeScript: it is reported as unread instead
    if (COMPONENT_EXTENSION.test(file) && !plugins.getFilePreprocessors().some((preprocessor) => preprocessor.test(file))) continue;
    try {
      // A UTF-16 code unit takes at most 3 bytes in UTF-8, so a file of more than 3 bytes per allowed
      // character is over the limit whatever it holds: refused before reading it (a link to a huge file)
      if ((await fs.stat(file)).size > limit * 3) {
        ignored.push({ file, reason: oversizedReason(limit) });
        continue;
      }
      const raw = await fs.readFile(file, "utf8");
      if (isOversized(raw, limit)) {
        ignored.push({ file, reason: oversizedReason(limit) });
        continue;
      }

      const virtualFiles = await plugins.preprocessFile({ fileName: file, content: raw });

      const parsedFiles = [];
      for (const virtualFile of virtualFiles) parsedFiles.push(await processFile(virtualFile.fileName, virtualFile.content));
      // code nested beyond what the TypeScript binder can walk would abort the whole scan: skip this file, say why
      if (parsedFiles.some((parsed) => parsed.depth > MAX_AST_DEPTH)) {
        skipped.push({ file, reason: TOO_DEEP_REASON });
        continue;
      }

      for (const [index, virtualFile] of virtualFiles.entries()) {
        const parsed = parsedFiles[index];
        const syntaxError = syntaxErrorOf(file, virtualFile.fileName, parsed, plugins);
        if (syntaxError) syntaxErrors.push(syntaxError);
        const scanPath = path.resolve(virtualFile.fileName);
        cache.set(scanPath, parsed);
        toScan.add(scanPath);
      }
    } catch (err) {
      skipped.push(skippedFrom(file, err));
    }
  }

  const virtualFiles = [SDK_TYPES_FILE, ...toScan].map((f) => getVirtualFile(f));

  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES_FILE, EVENTRA_SDK_SHIM);
  for (const file of toScan) {
    // every path in toScan was parsed and cached in the loop above
    await engine.preloadFile(getVirtualFile(file), cache.get(file)!.content);
  }
  engine.endPreload();

  await engine.runFullAnalysis(virtualFiles, config);

  // a file whose code overflowed the analysis is reported as skipped, with the name of the real file
  for (const [virtual, reason] of engine.getUnanalysableFiles()) {
    const source = plugins.getSourceForVirtual(virtual) ?? virtual;
    skipped.push({ file: source, reason });
  }

  const results = new Map<string, ScanResult>();
  for (const file of toScan) {
    results.set(file, engine.getScanResult(getVirtualFile(file)));
  }

  return {
    engine,
    results,
    files,
    plugins,
    skipped,
    ignored,
    syntaxErrors,
    unread: await findUnreadComponents(config, plugins),
    partial: plugins.getPartialFiles(),
    notes: plugins.getPluginNotes(),
  };
}
