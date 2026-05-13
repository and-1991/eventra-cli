// src/engine/engine.ts

import path from "path";
import ts from "typescript";

import {
  CompilerContext
} from "../compiler/compilerContext";

import {
  Scheduler
} from "../compiler/scheduler";

import {
  ImportGraph
} from "../compiler/importGraph";

import {
  EvaluationCache
} from "../analysis/cache/evaluationCache";

import {
  ResolvedCallCache
} from "../analysis/cache/resolvedCallCache";

import {
  ResolvedExportCache
} from "../analysis/cache/resolvedExportCache";

import {
  invalidateSourceFileSymbols
} from "../analysis/cache/symbolInvalidation";

import {
  EventraConfig,
  ScanResult,
} from "../types";

import {
  scanSource
} from "../analysis/scanner/scanner";

import {
  extractEvents
} from "../analysis/extractor/extractor";

import {
  WrapperRegistry
} from "../analysis/symbols/wrapperRegistry";

const EMPTY_RESULT =
  (): ScanResult => ({

    events:
      new Set(),

    detectedFunctionWrappers:
      new Set(),

    detectedComponentWrappers:
      new Map(),
  });

export class EventraEngine {

  private readonly compiler:
    CompilerContext;

  private readonly scheduler:
    Scheduler;

  private readonly importGraph =
    new ImportGraph();

  private readonly evaluationCache =
    new EvaluationCache();

  private readonly resolvedCallCache =
    new ResolvedCallCache();

  private readonly resolvedExportCache =
    new ResolvedExportCache();

  private readonly wrapperRegistry:
    WrapperRegistry;

  private readonly fileResults =
    new Map<
      string,
      ScanResult
    >();

  private readonly normalizedPathCache =
    new Map<
      string,
      string
    >();

  private isPreloading =
    false;

  private lastConfig:
    EventraConfig = {

    events: [],

    wrappers: [],

    functionWrappers: [],

    sync: {
      include: [],
      exclude: [],
    },
  };

  constructor(
    rootDir: string
  ) {

    this.compiler =
      new CompilerContext(
        rootDir
      );

    this.wrapperRegistry = new WrapperRegistry();

    this.scheduler =
      new Scheduler(

        async (updates) => {

          //
          // APPLY UPDATES
          //

          for (
            const [file, content]
            of updates
            ) {

            //
            // SYMBOL INVALIDATION
            //

            const existing =
              this.compiler.getSourceFile(
                file,
              );

            if (existing) {

              invalidateSourceFileSymbols(
                existing,

                this.compiler.getChecker(),

                this.evaluationCache,

                this.resolvedCallCache,

                this.resolvedExportCache,
              );
            }

            //
            // UPDATE FILE
            //

            await this.compiler.updateFile(
              file,
              content,
            );

            //
            // UPDATE IMPORT GRAPH
            //

            this.updateImportGraph(
              file,
            );
          }

          //
          // COLLECT AFFECTED FILES
          //

          const affected =
            new Set<string>();

          for (
            const file
            of updates.keys()
            ) {

            const dependents =
              this.importGraph
                .collectDependents(
                  file,
                );

            for (
              const dependent
              of dependents
              ) {

              affected.add(
                dependent,
              );
            }
          }

          //
          // RE-ANALYZE
          //

          for (
            const file
            of affected
            ) {

            this.analyzeFile(
              file,
              this.lastConfig,
            );
          }
        },
      );
  }

  private invalidateCaches():
    void {

    this.evaluationCache
      .clear();

    this.resolvedCallCache
      .clear();

    this.resolvedExportCache
      .clear();

    this.wrapperRegistry
      .clear();
  }

  beginPreload():
    void {

    this.isPreloading =
      true;
  }

  endPreload():
    void {

    this.isPreloading =
      false;
  }

  private normalize(
    fileName: string,
  ): string {

    const cached =
      this.normalizedPathCache.get(
        fileName,
      );

    if (cached) {

      return cached;
    }

    const normalized =
      path.resolve(fileName)
        .replace(/\\/g, "/");

    this.normalizedPathCache.set(
      fileName,
      normalized,
    );

    return normalized;
  }

  private updateImportGraph(
    fileName: string,
  ): void {

    const normalized =
      this.normalize(fileName);

    const source =
      this.compiler.getSourceFile(
        normalized,
      );

    if (!source) {

      this.importGraph.removeFile(
        normalized,
      );

      return;
    }

    const imports:
      string[] = [];

    for (
      const statement
      of source.statements
      ) {

      if (
        ts.isExportAssignment(
          statement,
        )
      ) {

        continue;
      }

      if (
        !ts.isImportDeclaration(
          statement,
        )
        && !ts.isExportDeclaration(
          statement,
        )
      ) {

        continue;
      }

      const specifier =
        statement.moduleSpecifier;

      if (
        !specifier
        || !ts.isStringLiteral(
          specifier,
        )
      ) {

        continue;
      }

      const resolved =
        this.compiler.resolveModule(
          specifier.text,

          this.compiler.getRealFileName(
            source.fileName,
          ),
        );

      if (!resolved) {

        continue;
      }

      imports.push(
        this.normalize(
          resolved,
        ),
      );
    }

    this.importGraph.updateFile(
      normalized,
      imports,
    );
  }

  private analyzeFile(
    fileName: string,
    config: EventraConfig,
  ): ScanResult {

    const normalized =
      this.normalize(fileName);

    const source =
      this.compiler.getSourceFile(
        normalized,
      );

    if (!source) {

      this.fileResults.delete(
        normalized,
      );

      return EMPTY_RESULT();
    }

    const checker =
      this.compiler.getChecker();

    const index =
      scanSource(
        source,
        checker,
        config,
        this.resolvedCallCache,
        this.resolvedExportCache,
        this.wrapperRegistry,
      );

    const result =
      extractEvents(
        index,
        checker,
        config,
        this.evaluationCache,
        this.resolvedExportCache,
        this.resolvedCallCache,
        this.wrapperRegistry,
      );

    this.fileResults.set(
      normalized,
      result,
    );

    return result;
  }

  async preloadFile(
    fileName: string,
    content: string,
  ): Promise<void> {

    if (
      !this.isPreloading
    ) {

      throw new Error(
        "preload phase not active",
      );
    }

    const normalized =
      this.normalize(fileName);

    await this.compiler.updateFile(
      normalized,
      content,
    );

    this.updateImportGraph(
      normalized,
    );
  }

  async updateFile(
    fileName: string,
    content: string,
    config: EventraConfig,
  ): Promise<void> {

    this.lastConfig =
      config;

    const normalized =
      this.normalize(fileName);

    await this.scheduler.enqueue(
      normalized,
      content,
    );
  }

  scanFile(
    fileName: string,
    config: EventraConfig,
  ): ScanResult {

    this.lastConfig =
      config;

    return this.analyzeFile(
      fileName,
      config,
    );
  }

  async syncFile(
    fileName: string,
    content: string,
    config: EventraConfig,
  ): Promise<ScanResult> {

    this.lastConfig =
      config;

    const normalized =
      this.normalize(fileName);

    const existing =
      this.compiler.getSourceFile(
        normalized,
      );

    if (existing) {

      invalidateSourceFileSymbols(
        existing,

        this.compiler.getChecker(),

        this.evaluationCache,

        this.resolvedCallCache,

        this.resolvedExportCache,
      );
    }

    await this.compiler.updateFile(
      normalized,
      content,
    );

    this.updateImportGraph(
      normalized,
    );

    return this.analyzeFile(
      normalized,
      config,
    );
  }

  async removeFile(
    fileName: string,
    config?: EventraConfig,
  ): Promise<void> {

    const normalized =
      this.normalize(fileName);

    this.invalidateCaches();

    const affected =
      this.importGraph
        .collectDependents(
          normalized,
        );

    this.importGraph.removeFile(
      normalized,
    );

    this.compiler.removeFile(
      normalized,
    );

    this.fileResults.delete(
      normalized,
    );

    this.normalizedPathCache.delete(
      fileName,
    );

    this.normalizedPathCache.delete(
      normalized,
    );

    const nextConfig =
      config
      ?? this.lastConfig;

    for (
      const file
      of affected
      ) {

      if (
        file === normalized
      ) {

        continue;
      }

      this.analyzeFile(
        file,
        nextConfig,
      );
    }
  }

  getResult(
    fileName: string,
  ): ScanResult {

    return (
      this.fileResults.get(
        this.normalize(
          fileName,
        ),
      )
      ?? EMPTY_RESULT()
    );
  }

  getAllEvents():
    string[] {

    const events =
      new Set<string>();

    for (
      const result
      of this.fileResults.values()
      ) {

      for (
        const event
        of result.events
        ) {

        events.add(
          event,
        );
      }
    }

    return [
      ...events,
    ].sort();
  }

  getDiagnostics(
    fileName?: string,
  ) {

    return this.compiler
      .getSemanticDiagnostics(
        fileName,
      );
  }

  invalidate():
    void {

    this.invalidateCaches();

    this.fileResults.clear();
  }
}
