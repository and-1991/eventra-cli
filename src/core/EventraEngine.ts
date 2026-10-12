import path from "path";
import ts from "typescript";

import { CompilerContext } from "../compiler/compilerContext";
import { Scheduler } from "../compiler/scheduler";
import { ImportGraph } from "../compiler/importGraph";
import { EvaluationCache } from "../analysis/cache/evaluationCache";
import { ResolvedCallCache } from "../analysis/cache/resolvedCallCache";
import { ResolvedExportCache } from "../analysis/cache/resolvedExportCache";
import { ReturnPropagationCache } from "../analysis/cache/returnPropagationCache";
import { indexSourceFile, extractFromIndex } from "../analysis/engine/analyzeFile";
import { FileSemanticIndex } from "../analysis/shared/types";
import { DynamicOccurrence } from "../analysis/shared/dynamicOccurrence";
import { EventraConfig, ScanResult } from "../types";
import { WrapperRegistry } from "../analysis/symbols/wrapperRegistry";
import { createBuiltinPluginRegistry } from "../plugin/loadPlugins";
import type { PluginRegistry } from "../plugin/registry";

const EMPTY_RESULT = (): ScanResult => ({
  events: new Set(),
  detectedFunctionWrappers: new Set(),
  dynamicOccurrences: [],
});

export class EventraEngine {
  private readonly compiler: CompilerContext;
  private readonly scheduler: Scheduler;
  private readonly importGraph = new ImportGraph();
  private readonly evaluationCache = new EvaluationCache();
  private readonly resolvedCallCache = new ResolvedCallCache();
  private readonly returnPropagationCache = new ReturnPropagationCache();
  private readonly resolvedExportCache = new ResolvedExportCache();
  private readonly wrapperRegistry: WrapperRegistry;
  private readonly fileIndices = new Map<string, FileSemanticIndex>();
  private readonly fileResults = new Map<string, ScanResult>();
  private readonly normalizedPathCache = new Map<string, string>();
  // files whose events count (the scanned sources); files that are in the
  // program only because something imports them are never extracted, as in a
  // fresh scan
  private readonly scannedFiles = new Set<string>();
  private readonly plugins: PluginRegistry;
  private isPreloading = false;
  private lastConfig: EventraConfig = {
    events: [],
    functionWrappers: [],
    sync: {
      include: [],
      exclude: [],
    },
  };

  constructor(rootDir: string, plugins: PluginRegistry = createBuiltinPluginRegistry()) {
    this.plugins = plugins;
    this.compiler = new CompilerContext(rootDir);
    // resolved lazily: asking for the checker now would build the program
    this.wrapperRegistry = new WrapperRegistry(
      () => this.compiler.getChecker(),
      this.resolvedExportCache,
    );
    this.scheduler = new Scheduler(async (updates) => {
      const changedFiles = new Set<string>();
      // a file the graph has not seen yet changes what other files' imports resolve to
      let fileSetChanged = false;

      // Stage every file, rebuild the program ONCE, then refresh the import
      // graph against that final program (one rebuild per flush, not per file).
      for (const [file, content] of updates) {
        if (!this.importGraph.hasFile(file)) fileSetChanged = true;
        this.scannedFiles.add(file);
        this.compiler.stageFile(file, content);
        changedFiles.add(file);
      }
      this.compiler.flushUpdates();
      const edgeChanged = new Set<string>();
      this.compiler.withResolutionCache(() => {
        for (const file of changedFiles) {
          this.updateImportGraph(file);
        }
      });
      if (fileSetChanged) {
        for (const file of this.refreshImportEdges(changedFiles)) edgeChanged.add(file);
      }

      // Program was rebuilt → every ts.Symbol from the previous program is now
      // dead. WeakMap-keyed caches (incl. WrapperRegistry) must be dropped before
      // we touch any NEW symbols, otherwise cross-file wrapper lookups miss.
      this.resetCaches();
      this.refreshChecker();

      // Full re-index: WrapperRegistry must contain entries keyed by NEW
      // symbols for every file, otherwise affected files cannot resolve
      // wrappers defined in unaffected files (this is the watch-corruption bug).
      this.reindexAll(this.lastConfig);

      // Incremental extract: only re-extract changed files + their dependents
      // (+ files whose imports now resolve differently, and their dependents).
      // Unaffected files keep their previously-computed Set<string> events,
      // which is safe (just strings, no AST refs).
      const affected = new Set<string>();
      for (const file of [...changedFiles, ...edgeChanged]) {
        affected.add(file);
        for (const dependent of this.importGraph.collectDependents(file)) {
          affected.add(dependent);
        }
      }
      for (const file of affected) {
        if (this.scannedFiles.has(file)) this.extractFile(file, this.lastConfig);
      }
    });
  }

  // drop every symbol-keyed cache; call after a program rebuild
  private resetCaches(): void {
    this.evaluationCache.clear();
    this.resolvedCallCache.clear();
    this.resolvedExportCache.clear();
    this.returnPropagationCache.clear();
    this.wrapperRegistry.clear();
  }

  // re-index every source file in the current program (skips .d.ts)
  private reindexAll(config: EventraConfig): void {
    const sources = this.compiler.getAllSourceFiles();
    this.fileIndices.clear();
    for (const sf of sources) {
      this.indexFile(sf.fileName, config);
    }
  }

  beginPreload(): void {
    this.isPreloading = true;
  }

  private normalize(fileName: string): string {
    const cached = this.normalizedPathCache.get(fileName);
    if (cached) {
      return cached;
    }
    const normalized = path.resolve(fileName).replace(/\\/g, "/");
    this.normalizedPathCache.set(fileName, normalized);
    return normalized;
  }

  // true when the file's resolved imports changed
  private updateImportGraph(fileName: string): boolean {
    const normalized = this.normalize(fileName);
    const source = this.compiler.getSourceFile(normalized);
    if (!source) {
      const known = this.importGraph.hasFile(normalized);
      this.importGraph.removeFile(normalized);
      return known;
    }
    const imports: string[] = [];
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement)) {
        continue;
      }
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
        continue;
      }
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) {
        continue;
      }
      const resolved = this.compiler.resolveModule(specifier.text, source.fileName);
      if (!resolved) {
        continue;
      }
      imports.push(this.normalize(resolved));
    }
    return this.importGraph.updateFile(normalized, imports);
  }

  /**
   * Creating or deleting a file can change what OTHER files' imports resolve to,
   * without those files changing: an import written before its target existed
   * starts to resolve, a deleted target stops. Their edges are re-resolved
   * against the current program; the files whose imports changed are returned
   * so they get analysed again (the graph alone cannot know about them: the
   * reverse edge of a file that did not exist was never recorded).
   */
  private refreshImportEdges(skip: ReadonlySet<string>): Set<string> {
    const changed = new Set<string>();
    this.compiler.withResolutionCache(() => {
      for (const file of this.importGraph.getFiles()) {
        if (skip.has(file)) continue;
        if (this.updateImportGraph(file)) changed.add(file);
      }
    });
    return changed;
  }

  async preloadFile(fileName: string, content: string): Promise<void> {
    if (!this.isPreloading) {
      throw new Error("preload phase not active");
    }
    const normalized = this.normalize(fileName);
    // processFile only echoed fileName/content back (its dependency list was
    // unused here), so stage directly instead of parsing the file a second time.
    this.compiler.stageFile(normalized, content);
  }

  endPreload(): void {
    this.isPreloading = false;
    this.compiler.flushUpdates();
    this.compiler.withResolutionCache(() => {
      for (const sourceFile of this.compiler.getAllSourceFiles()) {
        this.updateImportGraph(sourceFile.fileName);
      }
    });
  }

  async updateFile(fileName: string, content: string, config: EventraConfig): Promise<void> {
    this.lastConfig = config;
    const normalized = this.normalize(fileName);
    await this.scheduler.enqueue(normalized, content);
  }

  private refreshChecker(): void {
    this.wrapperRegistry.setChecker(this.compiler.getChecker());
  }

  async runFullAnalysis(fileNames: readonly string[], config: EventraConfig): Promise<void> {
    this.lastConfig = config;
    this.refreshChecker();
    const normalized = fileNames.map((f) => this.normalize(f));
    for (const file of normalized) {
      this.scannedFiles.add(file);
      this.indexFile(file, config);
    }
    for (const file of normalized) {
      this.extractFile(file, config);
    }
  }

  async reanalyzeFiles(fileNames: readonly string[], config: EventraConfig): Promise<void> {
    this.lastConfig = config;

    // Same correctness contract as the scheduler flush: the program may have
    // just been rebuilt (e.g. via removeFile), so clear symbol caches and
    // re-index every file before re-extracting the requested slice.
    this.resetCaches();
    this.refreshChecker();
    this.reindexAll(config);

    const normalized = fileNames.map((f) => this.normalize(f));
    for (const file of normalized) {
      if (this.scannedFiles.has(file)) this.extractFile(file, config);
    }
  }

  /**
   * Files that are only imported (not scanned, e.g. `shared/events.ts` outside
   * `include`) changed on disk, appeared or vanished. Their content is re-read
   * (one program rebuild for the whole batch), the import graph is refreshed and
   * the scanned files that depend on them are analysed again, so a long-running
   * engine agrees with a fresh scan. Returns false when no content changed.
   */
  async refreshExternalFiles(fileNames: readonly string[], config: EventraConfig): Promise<boolean> {
    this.lastConfig = config;
    const normalized = fileNames.map((f) => this.normalize(f));
    // dependents are read before the edges change
    const affected = new Set<string>();
    for (const file of normalized) {
      for (const dependent of this.importGraph.collectDependents(file)) {
        affected.add(dependent);
      }
    }
    const changed = this.compiler.refreshFromDisk(normalized);
    if (changed.length === 0) {
      return false;
    }
    this.compiler.withResolutionCache(() => {
      for (const file of changed) {
        this.updateImportGraph(file);
      }
    });
    // importers that had no edge before (a missing target appeared) or lost it
    // (the target vanished), and everything depending on them
    for (const file of this.refreshImportEdges(new Set(changed))) {
      affected.add(file);
      for (const dependent of this.importGraph.collectDependents(file)) {
        affected.add(dependent);
      }
    }
    for (const file of changed) {
      for (const dependent of this.importGraph.collectDependents(file)) {
        affected.add(dependent);
      }
    }
    for (const file of changed) {
      affected.delete(file);
    }
    await this.reanalyzeFiles([...affected], config);
    return true;
  }

  /** True when the file is in the program (scanned or only imported). */
  hasProgramFile(fileName: string): boolean {
    return this.compiler.hasFile(this.normalize(fileName));
  }

  /** Project files in the program, for watching those that live outside the project root. */
  getProjectFileNames(): string[] {
    return this.compiler.getProjectFileNames();
  }

  indexFile(fileName: string, _config: EventraConfig): void {
    const normalized = this.normalize(fileName);
    const source = this.compiler.getSourceFile(normalized);
    if (!source) {
      this.fileIndices.delete(normalized);
      return;
    }
    const index = indexSourceFile(
      source,
      this.compiler.getChecker(),
      this.wrapperRegistry,
      this.plugins,
    );
    this.fileIndices.set(normalized, index);
  }

  extractFile(fileName: string, config: EventraConfig): ScanResult {
    const normalized = this.normalize(fileName);
    const index = this.fileIndices.get(normalized);
    if (!index) {
      this.fileResults.delete(normalized);
      return EMPTY_RESULT();
    }
    const result = extractFromIndex(
      index,
      config,
      this.compiler.getChecker(),
      this.wrapperRegistry,
      this.evaluationCache,
      this.resolvedCallCache,
      this.returnPropagationCache,
      this.resolvedExportCache,
    );
    this.fileResults.set(normalized, result);
    return result;
  }

  async scanFile(fileName: string, config: EventraConfig): Promise<ScanResult> {
    this.lastConfig = config;
    this.scannedFiles.add(this.normalize(fileName));
    this.refreshChecker();
    this.indexFile(fileName, config);
    return this.extractFile(fileName, config);
  }

  async removeFile(fileName: string, config?: EventraConfig): Promise<void> {
    const normalized = this.normalize(fileName);
    const affected = this.importGraph.collectDependents(normalized);
    this.importGraph.removeFile(normalized);
    this.compiler.removeFile(normalized);
    this.fileIndices.delete(normalized);
    this.fileResults.delete(normalized);
    this.scannedFiles.delete(normalized);
    this.normalizedPathCache.delete(fileName);
    this.normalizedPathCache.delete(normalized);

    // importers of the removed file now resolve differently (and another file
    // may now win a resolution the removed one was shadowing)
    for (const file of this.refreshImportEdges(new Set([normalized]))) {
      for (const dependent of this.importGraph.collectDependents(file)) {
        affected.add(dependent);
      }
    }

    const nextConfig = config ?? this.lastConfig;
    const toReanalyze = [...affected].filter((f) => f !== normalized);
    // reanalyzeFiles already resets caches + reindexes all sources,
    // which is what we need after compiler.removeFile rebuilds the program.
    if (toReanalyze.length > 0) {
      await this.reanalyzeFiles(toReanalyze, nextConfig);
    } else {
      // Even without dependents, the program changed → caches must be reset
      // so the next call (e.g. runFullAnalysis) sees a clean slate.
      this.resetCaches();
      this.refreshChecker();
    }
  }

  getAllEvents(): string[] {
    const events = new Set<string>();
    for (const result of this.fileResults.values()) {
      for (const event of result.events) {
        events.add(event);
      }
    }
    return [...events].sort();
  }

  getAllFunctionWrappers(): string[] {
    const wrappers = new Set<string>();
    for (const result of this.fileResults.values()) {
      for (const name of result.detectedFunctionWrappers) {
        if (name && name !== "anonymous" && !name.startsWith("__")) {
          wrappers.add(name);
        }
      }
    }
    return [...wrappers].sort();
  }

  getScanResult(fileName: string): ScanResult {
    return this.fileResults.get(this.normalize(fileName)) ?? EMPTY_RESULT();
  }

  getAllDynamicOccurrences(): DynamicOccurrence[] {
    const occurrences: DynamicOccurrence[] = [];
    for (const result of this.fileResults.values()) {
      occurrences.push(...result.dynamicOccurrences);
    }
    const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return occurrences.sort(
      (a, b) => byText(a.fileName, b.fileName) || a.line - b.line || a.character - b.character,
    );
  }
}
