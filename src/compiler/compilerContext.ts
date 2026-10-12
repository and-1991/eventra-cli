import fs from "fs";
import path from "path";
import ts from "typescript";

import { DocumentRegistry } from "./documentRegistry";

interface CachedSourceFile {
  // content is compared, not the registry version: a removed and re-added file
  // starts again at version 1 with different text
  readonly content: string;
  readonly languageVersion: ts.ScriptTarget;
  readonly scriptKind: ts.ScriptKind;
  readonly sourceFile: ts.SourceFile;
}

export class CompilerContext {
  private readonly registry = new DocumentRegistry();
  // Parsed files survive a program rebuild: a flush changes a handful of files,
  // and parsing every other file (and the default lib .d.ts files) again was
  // most of the rebuild cost. Reusing a SourceFile object across programs is
  // what the TypeScript language service does too.
  private readonly sourceFileCache = new Map<string, CachedSourceFile>();
  private readonly compilerOptions: ts.CompilerOptions;
  private readonly host: ts.CompilerHost;
  // Built on first use (or by flushUpdates): the engine stages every file of a
  // scan and flushes once, so an eager build in the constructor was thrown away.
  private programInstance: ts.Program | undefined;
  private readonly rootNames = new Set<string>();
  // Only set while withResolutionCache() runs: it memoises fileExists results,
  // so it must never outlive one batch of resolutions against one program.
  private activeResolutionCache: ts.ModuleResolutionCache | undefined;

  constructor(private readonly rootDir: string) {
    const localTsconfig = path.join(rootDir, "tsconfig.json");
    const configPath = fs.existsSync(localTsconfig) ? localTsconfig : undefined;
    let compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      checkJs: false,
      strict: false,
      skipLibCheck: true,
      noEmit: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      allowNonTsExtensions: true,
      incremental: false,
    };

    if (configPath) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (config.error) {
        throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
      }
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(configPath),
      );
      compilerOptions = {
        ...compilerOptions,
        ...parsed.options,
      };
      for (const file of parsed.fileNames) {
        this.rootNames.add(this.normalize(file));
      }
    }

    this.compilerOptions = compilerOptions;
    this.host = ts.createCompilerHost(this.compilerOptions, true);
    this.patchCompilerHost();
  }

  private normalize(fileName: string): string {
    return this.registry.normalize(fileName);
  }

  private resolveLanguageVersion(
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
  ): ts.ScriptTarget {
    if (typeof languageVersionOrOptions === "object") {
      return languageVersionOrOptions.languageVersion;
    }
    return languageVersionOrOptions;
  }

  private attachVersion(sourceFile: ts.SourceFile, fileName: string): ts.SourceFile {
    const normalized = this.normalize(fileName);
    (sourceFile as ts.SourceFile & { version?: string }).version =
      this.registry.getVersion(normalized);
    return sourceFile;
  }

  private createSourceFileFromRegistry(
    fileName: string,
    languageVersion: ts.ScriptTarget,
  ): ts.SourceFile | undefined {
    const normalized = this.normalize(fileName);
    const snapshot = this.registry.getSnapshot(normalized);
    if (!snapshot) {
      return undefined;
    }
    const content = snapshot.getText(0, snapshot.getLength());
    const scriptKind = this.getScriptKind(normalized);
    const cached = this.sourceFileCache.get(normalized);
    if (
      cached &&
      cached.content === content &&
      cached.languageVersion === languageVersion &&
      cached.scriptKind === scriptKind
    ) {
      return this.attachVersion(cached.sourceFile, normalized);
    }
    const sourceFile = ts.createSourceFile(normalized, content, languageVersion, true, scriptKind);
    this.sourceFileCache.set(normalized, { content, languageVersion, scriptKind, sourceFile });
    return this.attachVersion(sourceFile, normalized);
  }

  private patchCompilerHost(): void {
    const originalGetSourceFile = this.host.getSourceFile.bind(this.host);
    this.host.getSourceFile = (
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      const languageVersion = this.resolveLanguageVersion(languageVersionOrOptions);
      const normalized = this.normalize(fileName);
      this.registry.ensure(normalized);
      const fromRegistry = this.createSourceFileFromRegistry(normalized, languageVersion);
      if (fromRegistry) {
        return fromRegistry;
      }
      const fromDisk = originalGetSourceFile(
        normalized,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
      /* v8 ignore if -- unreachable: host.readFile (below) only ever returns a string or throws (fs.readFileSync semantics); ts's default getSourceFile only yields undefined when readFile resolves to undefined without throwing, which this host can never produce */
      if (!fromDisk) {
        return undefined;
      }
      /* v8 ignore else -- unreachable: reaching this line already required an undefined snapshot above, and DocumentRecord always carries a snapshot once registry.has() is true, so has() cannot have flipped true in between */
      if (!this.registry.has(normalized)) {
        this.registry.update(normalized, fromDisk.getFullText());
      }
      return this.attachVersion(fromDisk, normalized);
    };

    this.host.readFile = (fileName) => {
      const normalized = this.normalize(fileName);
      this.registry.ensure(normalized);
      return this.registry.getContent(normalized) ?? fs.readFileSync(normalized, "utf8");
    };

    this.host.fileExists = (fileName) => {
      const normalized = this.normalize(fileName);
      return this.registry.has(normalized) || fs.existsSync(normalized);
    };

    this.host.getCanonicalFileName = (f) => this.normalize(f);
    this.host.useCaseSensitiveFileNames = () => true;
    this.host.getCurrentDirectory = () => this.rootDir;
    this.host.getNewLine = () => "\n";
  }

  private getScriptKind(fileName: string): ts.ScriptKind {
    if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
    if (fileName.endsWith(".ts")) return ts.ScriptKind.TS;
    if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
    if (fileName.endsWith(".js")) return ts.ScriptKind.JS;
    if (fileName.endsWith(".json")) return ts.ScriptKind.JSON;
    return ts.ScriptKind.Unknown;
  }

  private rebuildProgram(): void {
    this.programInstance = ts.createProgram([...this.rootNames], this.compilerOptions, this.host);
  }

  private get program(): ts.Program {
    if (!this.programInstance) {
      this.rebuildProgram();
    }
    return this.programInstance!;
  }

  /**
   * Run `fn` with one shared module resolution cache, so resolving the imports
   * of many files in a row (import graph after a flush) does not repeat the
   * same directory lookups. The cache is dropped when `fn` returns.
   */
  withResolutionCache<T>(fn: () => T): T {
    if (this.activeResolutionCache) {
      return fn();
    }
    this.activeResolutionCache = ts.createModuleResolutionCache(
      this.rootDir,
      (fileName) => this.normalize(fileName),
      this.compilerOptions,
    );
    try {
      return fn();
    } finally {
      this.activeResolutionCache = undefined;
    }
  }

  /** Register file content without rebuilding the TS program (batch via {@link flushUpdates}). */
  stageFile(fileName: string, content: string): void {
    const normalized = this.normalize(fileName);
    this.registry.update(normalized, content);
    this.rootNames.add(normalized);
  }

  flushUpdates(): void {
    this.rebuildProgram();
  }

  // accept content as-is; the engine layer is responsible for parsing via processFile
  updateFile(fileName: string, content: string): void {
    const normalized = this.normalize(fileName);
    this.stageFile(normalized, content);
    this.rebuildProgram();
  }

  removeFile(fileName: string): void {
    const normalized = this.normalize(fileName);
    this.registry.remove(normalized);
    this.sourceFileCache.delete(normalized);
    this.rootNames.delete(normalized);
    this.rebuildProgram();
  }

  /**
   * Re-reads files that are in the program only because something imports them
   * (they are not scanned sources): the disk content replaces whatever the
   * registry cached and the program is rebuilt ONCE for the whole batch. A file
   * that no longer exists is dropped. Returns the files whose content really
   * changed (normalized); none of them ever becomes a root.
   */
  refreshFromDisk(fileNames: readonly string[]): string[] {
    const changed: string[] = [];
    for (const fileName of fileNames) {
      const normalized = this.normalize(fileName);
      const before = this.registry.getContent(normalized);
      let content: string | undefined;
      try {
        content = fs.readFileSync(normalized, "utf8");
      } catch {
        content = undefined;
      }
      if (before === content) continue;
      if (content === undefined) {
        this.registry.remove(normalized);
        this.sourceFileCache.delete(normalized);
      } else {
        this.registry.update(normalized, content);
      }
      changed.push(normalized);
    }
    if (changed.length === 0) {
      return changed;
    }
    this.rebuildProgram();
    // a file nothing imports must not linger in the registry
    for (const normalized of changed) {
      if (this.registry.has(normalized) && !this.programInstance!.getSourceFile(normalized)) {
        this.registry.remove(normalized);
        this.sourceFileCache.delete(normalized);
      }
    }
    return changed;
  }

  /** True when the file is part of the current program (scanned or only imported). */
  hasFile(fileName: string): boolean {
    return this.program.getSourceFile(this.normalize(fileName)) !== undefined;
  }

  /** Project files of the program (no TypeScript libs, no node_modules), declaration files included. */
  getProjectFileNames(): string[] {
    const program = this.program;
    return program
      .getSourceFiles()
      .filter((sf) => !program.isSourceFileDefaultLibrary(sf) && !program.isSourceFileFromExternalLibrary(sf))
      .map((sf) => sf.fileName);
  }

  getProgram(): ts.Program {
    return this.program;
  }

  getChecker(): ts.TypeChecker {
    return this.program.getTypeChecker();
  }

  getSourceFile(fileName: string): ts.SourceFile | undefined {
    return this.program.getSourceFile(this.normalize(fileName));
  }

  getSemanticDiagnostics(fileName?: string): readonly ts.Diagnostic[] {
    if (!fileName) {
      return ts.getPreEmitDiagnostics(this.program);
    }
    const sourceFile = this.getSourceFile(fileName);
    if (!sourceFile) {
      return [];
    }
    return [
      ...this.program.getSemanticDiagnostics(sourceFile),
      ...this.program.getSyntacticDiagnostics(sourceFile),
    ];
  }

  resolveModule(moduleName: string, fromFile: string): string | undefined {
    const resolved = ts.resolveModuleName(
      moduleName,
      this.normalize(fromFile),
      this.compilerOptions,
      this.host,
      this.activeResolutionCache,
    );
    return resolved.resolvedModule?.resolvedFileName;
  }

  getResolvedModules(fileName: string): string[] {
    const source = this.getSourceFile(fileName);
    if (!source) {
      return [];
    }
    const modules = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
        continue;
      }
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) {
        continue;
      }
      const resolved = this.resolveModule(specifier.text, source.fileName);
      if (resolved) {
        modules.add(this.normalize(resolved));
      }
    }
    return [...modules];
  }

  getAllSourceFiles(): ts.SourceFile[] {
    return this.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile);
  }
}
