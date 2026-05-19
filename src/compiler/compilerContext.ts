import fs from "fs";
import path from "path";
import ts from "typescript";

import { DocumentRegistry } from "./documentRegistry";
import { processFile } from "../filesystem/processFile";

export class CompilerContext {
  private readonly registry = new DocumentRegistry();
  private readonly compilerOptions: ts.CompilerOptions;
  private readonly host: ts.CompilerHost;
  private program: ts.Program = ts.createProgram([], {});
  private readonly rootNames = new Set<string>();

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
    this.rebuildProgram();
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
    const sourceFile = ts.createSourceFile(
      normalized,
      snapshot.getText(0, snapshot.getLength()),
      languageVersion,
      true,
      this.getScriptKind(normalized),
    );
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
      if (!fromDisk) {
        return undefined;
      }
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
    this.program = ts.createProgram([...this.rootNames], this.compilerOptions, this.host);
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

  async updateFile(fileName: string, content: string): Promise<void> {
    const normalized = this.normalize(fileName);
    const processed = await processFile(normalized, content);
    this.stageFile(processed.fileName, processed.content);
    this.rebuildProgram();
  }

  removeFile(fileName: string): void {
    const normalized = this.normalize(fileName);
    this.registry.remove(normalized);
    this.rootNames.delete(normalized);
    this.rebuildProgram();
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
