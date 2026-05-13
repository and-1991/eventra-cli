import fs from "fs";
import path from "path";
import ts from "typescript";

import {
  DocumentRegistry,
} from "./documentRegistry";

import {
  processFile,
} from "../filesystem/processFile";

export class CompilerContext {

  private readonly registry =
    new DocumentRegistry();

  private readonly compilerOptions:
    ts.CompilerOptions;

  private readonly host:
    ts.CompilerHost;

  private builder:
    ts.EmitAndSemanticDiagnosticsBuilderProgram;

  private readonly rootNames =
    new Set<string>();

  constructor(
    private readonly rootDir: string,
  ) {

    const configPath =
      ts.findConfigFile(
        rootDir,
        ts.sys.fileExists,
        "tsconfig.json",
      );

    let compilerOptions:
      ts.CompilerOptions = {

      target:
      ts.ScriptTarget.ESNext,

      module:
      ts.ModuleKind.ESNext,

      moduleResolution:
      ts.ModuleResolutionKind.Bundler,

      jsx:
      ts.JsxEmit.Preserve,

      allowJs: true,

      checkJs: false,

      strict: false,

      skipLibCheck: true,

      noEmit: true,

      allowSyntheticDefaultImports: true,

      esModuleInterop: true,

      resolveJsonModule: true,

      allowNonTsExtensions: true,

      incremental: true,
    };

    if (configPath) {

      const config =
        ts.readConfigFile(
          configPath,
          ts.sys.readFile,
        );

      if (config.error) {

        throw new Error(
          ts.flattenDiagnosticMessageText(
            config.error.messageText,
            "\n",
          ),
        );
      }

      const parsed =
        ts.parseJsonConfigFileContent(
          config.config,
          ts.sys,
          path.dirname(configPath),
        );

      compilerOptions = {

        ...compilerOptions,
        ...parsed.options,
      };

      for (
        const file
        of parsed.fileNames
        ) {

        this.rootNames.add(
          this.normalize(file),
        );
      }
    }

    this.compilerOptions =
      compilerOptions;

    this.host =
      ts.createCompilerHost(
        this.compilerOptions,
        true,
      );

    this.patchCompilerHost();

    this.builder =
      ts.createEmitAndSemanticDiagnosticsBuilderProgram(
        [...this.rootNames],

        this.compilerOptions,

        this.host,
      );
  }

  private normalize(
    fileName: string,
  ): string {

    return this.registry
      .normalize(fileName);
  }

  private patchCompilerHost():
    void {

    const originalGetSourceFile =
      this.host.getSourceFile;

    this.host.getSourceFile = (
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) => {

      const normalized =
        this.normalize(fileName);

      this.registry.ensure(
        normalized,
      );

      const snapshot =
        this.registry.getSnapshot(
          normalized,
        );

      if (!snapshot) {

        return originalGetSourceFile(
          normalized,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
      }

      return ts.createSourceFile(
        normalized,

        snapshot.getText(
          0,
          snapshot.getLength(),
        ),

        languageVersion,

        true,

        this.getScriptKind(
          normalized,
        ),
      );
    };

    this.host.readFile = (
      fileName,
    ) => {

      const normalized =
        this.normalize(fileName);

      this.registry.ensure(
        normalized,
      );

      return (
        this.registry.getContent(
          normalized,
        )
        ?? fs.readFileSync(
          normalized,
          "utf8",
        )
      );
    };

    this.host.fileExists = (
      fileName,
    ) => {

      const normalized =
        this.normalize(fileName);

      return (
        this.registry.has(
          normalized,
        )
        || fs.existsSync(
          normalized,
        )
      );
    };

    this.host.getCanonicalFileName =
      (f) => this.normalize(f);

    this.host.useCaseSensitiveFileNames =
      () => true;

    this.host.getCurrentDirectory =
      () => this.rootDir;

    this.host.getNewLine =
      () => "\n";
  }

  private getScriptKind(
    fileName: string,
  ): ts.ScriptKind {

    if (
      fileName.endsWith(".tsx")
    ) {

      return ts.ScriptKind.TSX;
    }

    if (
      fileName.endsWith(".ts")
    ) {

      return ts.ScriptKind.TS;
    }

    if (
      fileName.endsWith(".jsx")
    ) {

      return ts.ScriptKind.JSX;
    }

    if (
      fileName.endsWith(".js")
    ) {

      return ts.ScriptKind.JS;
    }

    if (
      fileName.endsWith(".json")
    ) {

      return ts.ScriptKind.JSON;
    }

    return ts.ScriptKind.Unknown;
  }

  private rebuild():
    void {

    this.builder =
      ts.createEmitAndSemanticDiagnosticsBuilderProgram(
        [...this.rootNames],

        this.compilerOptions,

        this.host,

        this.builder,
      );
  }

  async updateFile(
    fileName: string,
    content: string,
  ): Promise<void> {

    const normalized =
      this.normalize(fileName);

    const processed =
      await processFile(
        normalized,
        content,
      );

    this.registry.update(
      processed.fileName,
      processed.content,
    );

    this.rootNames.add(
      processed.fileName,
    );

    this.rebuild();
  }

  removeFile(
    fileName: string,
  ): void {

    const normalized =
      this.normalize(fileName);

    this.registry.remove(
      normalized,
    );

    this.rootNames.delete(
      normalized,
    );

    this.rebuild();
  }

  invalidate():
    void {

    this.registry.invalidate();

    this.rebuild();
  }

  getProgram():
    ts.Program {

    return this.builder
      .getProgram();
  }

  getChecker():
    ts.TypeChecker {

    return this.builder
      .getProgram()
      .getTypeChecker();
  }

  getSourceFile(
    fileName: string,
  ):
    | ts.SourceFile
    | undefined {

    return this.builder
      .getProgram()
      .getSourceFile(
        this.normalize(
          fileName,
        ),
      );
  }

  getSemanticDiagnostics(
    fileName?: string,
  ):
    readonly ts.Diagnostic[] {

    const program =
      this.builder.getProgram();

    if (!fileName) {

      return ts.getPreEmitDiagnostics(
        program,
      );
    }

    const sourceFile =
      this.getSourceFile(
        fileName,
      );

    if (!sourceFile) {

      return [];
    }

    return [

      ...program.getSemanticDiagnostics(
        sourceFile,
      ),

      ...program.getSyntacticDiagnostics(
        sourceFile,
      ),
    ];
  }

  resolveModule(
    moduleName: string,
    fromFile: string,
  ):
    | string
    | undefined {

    const resolved =
      ts.resolveModuleName(
        moduleName,

        this.normalize(
          fromFile,
        ),

        this.compilerOptions,

        this.host,
      );

    return resolved
      .resolvedModule
      ?.resolvedFileName;
  }

  getResolvedModules(
    fileName: string,
  ): string[] {

    const source =
      this.getSourceFile(
        fileName,
      );

    if (!source) {

      return [];
    }

    const modules =
      new Set<string>();

    for (
      const statement
      of source.statements
      ) {

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
        this.resolveModule(
          specifier.text,
          source.fileName,
        );

      if (!resolved) {

        continue;
      }

      modules.add(
        this.normalize(
          resolved,
        ),
      );
    }

    return [
      ...modules,
    ];
  }

  getAllSourceFiles():
    ts.SourceFile[] {

    return this.builder
      .getProgram()
      .getSourceFiles()
      .filter(
        sf => !sf.isDeclarationFile,
      );
  }

  getRealFileName(
    fileName: string,
  ): string {

    return fileName;
  }
}
