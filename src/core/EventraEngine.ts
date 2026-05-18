import path from "path";
import ts from "typescript";

import { CompilerContext } from "../compiler/compilerContext";
import { Scheduler } from "../compiler/scheduler";
import { ImportGraph } from "../compiler/importGraph";
import { EvaluationCache } from "../analysis/cache/evaluationCache";
import { ResolvedCallCache } from "../analysis/cache/resolvedCallCache";
import { ResolvedExportCache } from "../analysis/cache/resolvedExportCache";
import { ReturnPropagationCache } from "../analysis/cache/returnPropagationCache";
import { invalidateSourceFileSymbols } from "../analysis/cache/symbolInvalidation";
import { indexSourceFile, extractFromIndex } from "../analysis/engine/analyzeFile";
import { FileSemanticIndex } from "../analysis/shared/types";
import { EventraConfig, ScanResult } from "../types";
import { WrapperRegistry } from "../analysis/symbols/wrapperRegistry";

const EMPTY_RESULT = (): ScanResult => ({
  events: new Set(),
  detectedFunctionWrappers: new Set(),
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
  private isPreloading = false;
  private lastConfig: EventraConfig = {
    events: [],
    functionWrappers: [],
    sync: {
      include: [],
      exclude: [],
    },
  };

  constructor(rootDir: string) {
    this.compiler = new CompilerContext(rootDir);
    this.wrapperRegistry = new WrapperRegistry(
      this.compiler.getChecker(),
      this.resolvedExportCache,
    );
    this.scheduler = new Scheduler(async (updates) => {
      const affected = new Set<string>();

      for (const [file, content] of updates) {
        const existing = this.compiler.getSourceFile(file);
        if (existing) {
          invalidateSourceFileSymbols(
            existing,
            this.compiler.getChecker(),
            this.evaluationCache,
            this.resolvedCallCache,
            this.resolvedExportCache,
            this.returnPropagationCache,
            this.wrapperRegistry,
          );
        }
        await this.compiler.updateFile(file, content);
        this.updateImportGraph(file);
        affected.add(file);
        for (const dependent of this.importGraph.collectDependents(file)) {
          affected.add(dependent);
        }
      }

      await this.reanalyzeFiles([...affected], this.lastConfig);
    });
  }

  beginPreload(): void {
    this.isPreloading = true;
  }

  endPreload(): void {
    this.isPreloading = false;
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

  private updateImportGraph(fileName: string): void {
    const normalized = this.normalize(fileName);
    const source = this.compiler.getSourceFile(normalized);
    if (!source) {
      this.importGraph.removeFile(normalized);
      return;
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
    this.importGraph.updateFile(normalized, imports);
  }

  async preloadFile(fileName: string, content: string): Promise<void> {
    if (!this.isPreloading) {
      throw new Error("preload phase not active");
    }
    const normalized = this.normalize(fileName);
    await this.compiler.updateFile(normalized, content);
    this.updateImportGraph(normalized);
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
      this.indexFile(file, config);
    }
    for (const file of normalized) {
      this.extractFile(file, config);
    }
  }

  async reanalyzeFiles(fileNames: readonly string[], config: EventraConfig): Promise<void> {
    this.lastConfig = config;
    this.refreshChecker();
    const normalized = fileNames.map((f) => this.normalize(f));
    for (const file of normalized) {
      this.indexFile(file, config);
    }
    for (const file of normalized) {
      this.extractFile(file, config);
    }
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
    this.refreshChecker();
    this.indexFile(fileName, config);
    return this.extractFile(fileName, config);
  }

  async removeFile(fileName: string, config?: EventraConfig): Promise<void> {
    const normalized = this.normalize(fileName);
    const existing = this.compiler.getSourceFile(normalized);
    if (existing) {
      invalidateSourceFileSymbols(
        existing,
        this.compiler.getChecker(),
        this.evaluationCache,
        this.resolvedCallCache,
        this.resolvedExportCache,
        this.returnPropagationCache,
        this.wrapperRegistry,
      );
    }
    const affected = this.importGraph.collectDependents(normalized);
    this.importGraph.removeFile(normalized);
    this.compiler.removeFile(normalized);
    this.fileIndices.delete(normalized);
    this.fileResults.delete(normalized);
    this.normalizedPathCache.delete(fileName);
    this.normalizedPathCache.delete(normalized);

    const nextConfig = config ?? this.lastConfig;
    const toReanalyze = [...affected].filter((f) => f !== normalized);
    if (toReanalyze.length > 0) {
      await this.reanalyzeFiles(toReanalyze, nextConfig);
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
}
