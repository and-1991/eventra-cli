import ts from "typescript";
import fs from "fs";
import path from "path";

export class TSService {
  private files = new Map<string, { version: number; content: string }>();
  private fileNames = new Set<string>();
  private service: ts.LanguageService;

  private compilerOptions: ts.CompilerOptions;
  private baseUrl: string;
  private paths: Record<string, string[]>;

  constructor(private root: string) {
    const configPath = ts.findConfigFile(
      root,
      ts.sys.fileExists,
      "tsconfig.json"
    );

    let compilerOptions: ts.CompilerOptions = {
      allowJs: true,
      allowNonTsExtensions: true,
      jsx: ts.JsxEmit.Preserve,
      jsxImportSource: "react",
      moduleResolution: ts.ModuleResolutionKind.Node16,
      target: ts.ScriptTarget.ESNext,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      skipLibCheck: true,
    };

    let baseUrl = root;
    let paths: Record<string, string[]> = {};

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

      paths = parsed.options.paths || {};
      baseUrl = parsed.options.baseUrl
        ? path.resolve(root, parsed.options.baseUrl)
        : root;
    }

    this.compilerOptions = compilerOptions;
    this.baseUrl = baseUrl;
    this.paths = paths;

    const allFiles = ts.sys.readDirectory(
      root,
      [".ts", ".tsx", ".js", ".jsx"],
      undefined,
      undefined
    );

    for (const f of allFiles) {
      this.fileNames.add(this.normalize(f));
    }

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => {
        return Array.from(this.fileNames);
      },

      getScriptVersion: (file) => {
        file = this.normalize(file);
        return this.files.get(file)?.version.toString() ?? "0";
      },
      getScriptKind: (fileName) => {
        fileName = this.normalize(fileName);

        if (fileName.endsWith(".tsx")) {
          return ts.ScriptKind.TSX;
        }

        if (fileName.endsWith(".ts")) {
          return ts.ScriptKind.TS;
        }

        if (fileName.endsWith(".jsx")) {
          return ts.ScriptKind.JSX;
        }

        if (fileName.endsWith(".js")) {
          return ts.ScriptKind.JS;
        }

        return ts.ScriptKind.Unknown;
      },
      getScriptSnapshot: (file) => {
        file = this.normalize(file);
        const f = this.files.get(file);
        if (f) {
          return ts.ScriptSnapshot.fromString(f.content);
        }

        try {
          if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, "utf-8");

            this.files.set(file, {
              content,
              version: 1,
            });

            this.fileNames.add(file);

            return ts.ScriptSnapshot.fromString(content);
          }
        } catch {
        }

        return ts.ScriptSnapshot.fromString("");
      },

      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (opts) =>
        ts.getDefaultLibFilePath(opts),

      fileExists: (file) => {
        file = this.normalize(file);
        return this.files.has(file) || ts.sys.fileExists(file);
      },

      readFile: (file) => {
        file = this.normalize(file);
        return this.files.get(file)?.content ?? ts.sys.readFile(file);
      },

      readDirectory: ts.sys.readDirectory,
    };

    this.service = ts.createLanguageService(host);
  }

  private normalize(file: string) {
    return path.resolve(file).replace(/\\/g, "/");
  }

  // PUBLIC API
  updateFile(file: string, content: string) {
    file = this.normalize(file);

    const prev = this.files.get(file);

    this.files.set(file, {
      content,
      version: prev ? prev.version + 1 : 1,
    });

    this.fileNames.add(file);
  }

  removeFile(file: string) {
    file = this.normalize(file);

    this.files.delete(file);
    this.fileNames.delete(file);
  }

  getProgram() {
    return this.service.getProgram();
  }

  getChecker() {
    return this.getProgram()?.getTypeChecker();
  }

  getSourceFile(file: string) {
    file = this.normalize(file);
    return this.getProgram()?.getSourceFile(file);
  }

  getFileContent(file: string) {
    file = this.normalize(file);
    return this.files.get(file)?.content;
  }

  getModuleResolutionConfig() {
    return {
      baseUrl: this.baseUrl,
      paths: this.paths,
    };
  }
}
