import ts from "typescript";
import fs from "fs";
import path from "path";

export class TSService {
  private files = new Map<string, { version: number; content: string }>();
  private fileNames = new Set<string>();
  private service: ts.LanguageService;

  private readonly compilerOptions: ts.CompilerOptions = {};
  private readonly baseUrl: string = "";
  private readonly paths: Record<string, string[]> = {};

  constructor(private root: string) {
    const configPath = ts.findConfigFile(
      root,
      ts.sys.fileExists,
      "tsconfig.json"
    );

    let compilerOptions: ts.CompilerOptions = {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      target: ts.ScriptTarget.ESNext,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    };

    if (configPath) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        root
      );

      compilerOptions = {
        ...compilerOptions,
        ...parsed.options,
      };

      this.paths = parsed.options.paths || {};
      this.baseUrl = parsed.options.baseUrl
        ? path.resolve(root, parsed.options.baseUrl)
        : root;
    } else {
      this.baseUrl = root;
    }

    this.compilerOptions = compilerOptions;

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => {
        return [...new Set(this.fileNames)].sort((a, b) =>
          a.localeCompare(b)
        );
      },

      getScriptVersion: (file) =>
        this.files.get(file)?.version.toString() ?? "0",

      getScriptSnapshot: (file) => {
        const f = this.files.get(file);

        if (f) {
          return ts.ScriptSnapshot.fromString(f.content);
        }

        if (fs.existsSync(file)) {
          return ts.ScriptSnapshot.fromString(
            fs.readFileSync(file, "utf-8")
          );
        }

        return undefined;
      },

      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (opts) =>
        ts.getDefaultLibFilePath(opts),

      readFile: ts.sys.readFile,
      fileExists: ts.sys.fileExists,
      readDirectory: ts.sys.readDirectory,
    };

    this.service = ts.createLanguageService(host);
  }

  updateFile(file: string, content: string) {
    const prev = this.files.get(file);

    this.files.set(file, {
      content,
      version: prev ? prev.version + 1 : 1,
    });

    this.fileNames.add(file);
  }

  getProgram() {
    return this.service.getProgram();
  }

  getChecker() {
    return this.getProgram()?.getTypeChecker();
  }

  getSourceFile(file: string) {
    return this.getProgram()?.getSourceFile(file);
  }

  getFileContent(file: string) {
    return this.files.get(file)?.content;
  }

  removeFile(file: string) {
    this.files.delete(file);
    this.fileNames.delete(file);
  }

  getModuleResolutionConfig() {
    return {
      baseUrl: this.baseUrl,
      paths: this.paths,
    };
  }
}
