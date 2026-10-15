import fs from "fs";
import path from "path";
import ts from "typescript";

import { DocumentRegistry } from "./documentRegistry";
import { findWorkspacePackages } from "./workspacePackages";

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
  // compiler options of the nearest tsconfig.json above a folder (the root one for files outside any other)
  private readonly optionsByDir = new Map<string, ts.CompilerOptions>();
  // the options a project starts from before any tsconfig.json is applied
  private readonly defaultOptions: ts.CompilerOptions;
  private readonly workspacePackages: ReadonlyMap<string, string>;
  // one module resolution cache per set of options; only alive while a program is built or a batch runs
  private readonly resolutionCaches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  // how many builds or batches are running that share the caches (a rebuild can start inside a batch)
  private cachingDepth = 0;

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

    this.defaultOptions = compilerOptions;
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
      // A solution-style tsconfig (`"files": []` plus `references`, the Vite and Vue template) keeps its
      // `@/*` aliases in a referenced config, so without this every aliased import stays unresolved.
      if (!parsed.options.paths) {
        Object.assign(compilerOptions, this.pathOptionsFromReferences(parsed.projectReferences));
      }
      for (const file of parsed.fileNames) {
        this.rootNames.add(this.normalize(file));
      }
    }

    this.compilerOptions = compilerOptions;
    this.workspacePackages = findWorkspacePackages(rootDir);
    this.host = ts.createCompilerHost(this.compilerOptions, true);
    this.patchCompilerHost();
  }

  private normalize(fileName: string): string {
    return this.registry.normalize(fileName);
  }

  /**
   * Compiler options for resolving the imports of `fromFile`: those of the nearest tsconfig.json above
   * it. A monorepo keeps one per app (`@/*` means a different folder in each) and often none at the root;
   * a single root-level tsconfig.json answers for every file below it, as it always did.
   */
  private optionsFor(fromFile: string): ts.CompilerOptions {
    // an installed package may ship a tsconfig.json of its own: its settings are for building it, not for this project
    if (fromFile.split(/[\\/]/).includes("node_modules")) return this.compilerOptions;
    const visited: string[] = [];
    let options = this.compilerOptions;
    for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
      const cached = this.optionsByDir.get(dir);
      const own = cached ?? this.readDirectoryOptions(dir);
      if (own) {
        options = own;
        visited.push(dir);
        break;
      }
      visited.push(dir);
      // a file outside the project, or the top of the filesystem, keeps the root options
      if (path.relative(this.rootDir, dir).startsWith("..") || path.dirname(dir) === dir || dir === this.rootDir) break;
    }
    for (const dir of visited) this.optionsByDir.set(dir, options);
    return options;
  }

  /** The options a folder's own tsconfig.json sets, `undefined` when it has none (the root's are already loaded). */
  private readDirectoryOptions(dir: string): ts.CompilerOptions | undefined {
    if (dir === this.rootDir) return this.compilerOptions;
    const configPath = path.join(dir, "tsconfig.json");
    if (!fs.existsSync(configPath)) return undefined;
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) return undefined;
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
    return {
      ...this.defaultOptions,
      ...parsed.options,
      ...(parsed.options.paths ? {} : this.aliasesWithout(parsed.options, parsed.projectReferences)),
    };
  }

  /**
   * Aliases for a config that sets no `paths` of its own: those of its project references, or else the root's.
   * A tsconfig.json that only adjusts a few options (a `tests/` one, say) does not mean the root's `@/*` stopped
   * being valid there, and the root's aliases applied to every file before configs were read per folder.
   */
  private aliasesWithout(own: ts.CompilerOptions, references: readonly ts.ProjectReference[] | undefined): ts.CompilerOptions {
    const fromReferences = this.pathOptionsFromReferences(references);
    if (fromReferences.paths) return fromReferences;
    const { paths, baseUrl, pathsBasePath } = this.compilerOptions;
    return { paths, baseUrl: own.baseUrl ?? baseUrl, pathsBasePath };
  }

  private cacheFor(options: ts.CompilerOptions): ts.ModuleResolutionCache | undefined {
    if (this.cachingDepth === 0) return undefined;
    let cache = this.resolutionCaches.get(options);
    if (!cache) {
      cache = ts.createModuleResolutionCache(this.rootDir, (fileName) => this.normalize(fileName), options);
      this.resolutionCaches.set(options, cache);
    }
    return cache;
  }

  /** Where a monorepo package's own folder is for an import of it (`@acme/lib`, `@acme/lib/hooks/x`), if it is one. */
  private workspaceTargets(moduleName: string): string[] {
    let best: { name: string; dir: string } | undefined;
    for (const [name, dir] of this.workspacePackages) {
      if ((moduleName === name || moduleName.startsWith(`${name}/`)) && (!best || name.length > best.name.length)) {
        best = { name, dir };
      }
    }
    if (!best) return [];
    const sub = moduleName.slice(best.name.length + 1);
    // the package's sources may sit in src/ while its package.json points at a build that is not there
    return [path.join(best.dir, sub), path.join(best.dir, "src", sub)];
  }

  private resolveImport(
    moduleName: string,
    containingFile: string,
    redirectedReference?: ts.ResolvedProjectReference,
    mode?: ts.ResolutionMode,
  ): ts.ResolvedModuleWithFailedLookupLocations {
    const options = this.optionsFor(containingFile);
    const cache = this.cacheFor(options);
    const resolved = ts.resolveModuleName(moduleName, containingFile, options, this.host, cache, redirectedReference, mode);
    if (resolved.resolvedModule) return resolved;
    // not installed, so no node_modules link: a package of this very monorepo is found by its folder
    for (const target of this.workspaceTargets(moduleName)) {
      const viaWorkspace = ts.resolveModuleName(target, containingFile, options, this.host, cache, redirectedReference, mode);
      if (viaWorkspace.resolvedModule) return viaWorkspace;
    }
    return resolved;
  }

  /**
   * Alias options (`paths`, `baseUrl`) of the first referenced tsconfig that defines `paths`. A
   * reference that is unreadable or has no aliases is skipped; only aliases are taken, never the files.
   */
  private pathOptionsFromReferences(
    references: readonly ts.ProjectReference[] | undefined,
  ): ts.CompilerOptions {
    for (const reference of references ?? []) {
      const referenced = ts.sys.directoryExists(reference.path)
        ? path.join(reference.path, "tsconfig.json")
        : reference.path;
      const config = ts.readConfigFile(referenced, ts.sys.readFile);
      if (config.error) continue;
      const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(referenced));
      if (options.paths) {
        const { paths, baseUrl, pathsBasePath } = options;
        return { paths, baseUrl, pathsBasePath };
      }
    }
    return {};
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

    this.host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, _options, containingSourceFile) =>
      literals.map((literal) =>
        this.resolveImport(
          literal.text,
          containingFile,
          redirectedReference,
          ts.getModeForUsageLocation(containingSourceFile, literal, this.compilerOptions),
        ),
      );
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
    // options are re-read from disk with every build, so an edited nested tsconfig.json is seen
    this.optionsByDir.clear();
    this.withSharedCaches(() => {
      this.programInstance = ts.createProgram([...this.rootNames], this.compilerOptions, this.host);
    });
  }

  /**
   * Imports resolved while `fn` runs share caches, as they do in TypeScript's own host. Files may appear or
   * go between runs, so nothing is kept after the outermost one; a run started inside another (a lazy
   * program build inside a batch) joins it instead of dropping its caches.
   */
  private withSharedCaches<T>(fn: () => T): T {
    if (this.cachingDepth === 0) this.resolutionCaches.clear();
    this.cachingDepth++;
    try {
      return fn();
    } finally {
      this.cachingDepth--;
      if (this.cachingDepth === 0) this.resolutionCaches.clear();
    }
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
    return this.withSharedCaches(fn);
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
    return this.resolveImport(moduleName, this.normalize(fromFile)).resolvedModule?.resolvedFileName;
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
