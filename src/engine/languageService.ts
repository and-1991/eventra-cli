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
  private usage = new Map<string, number>();
  private tick = 0;
  private MAX_FILES = 2000;

  constructor(private root: string) {
    const configPath = ts.findConfigFile(
      root,
      ts.sys.fileExists,
      "tsconfig.json"
    );

    let compilerOptions: ts.CompilerOptions = {
      allowJs: true,
      jsx: ts.JsxEmit.React,
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

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => Array.from(this.fileNames),

      getScriptVersion: (file) => {
        file = this.normalize(file);
        return this.files.get(file)?.version.toString() ?? "0";
      },

      getScriptSnapshot: (file) => {
        file = this.normalize(file);

        const f = this.files.get(file);
        if (f) {
          this.touch(file);
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
            this.touch(file);
            this.evictIfNeeded();

            return ts.ScriptSnapshot.fromString(content);
          }
        } catch {}

        // fallback
        return ts.ScriptSnapshot.fromString("");
      },

      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (opts) =>
        ts.getDefaultLibFilePath(opts),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
    };

    this.service = ts.createLanguageService(host);
  }

  // INTERNAL
  private normalize(file: string) {
    return path.resolve(file).replace(/\\/g, "/");
  }

  private touch(file: string) {
    this.tick++;
    this.usage.set(file, this.tick);
  }

  private evictIfNeeded() {
    if (this.fileNames.size <= this.MAX_FILES) return;

    let oldestFile: string | null = null;
    let oldestTick = Infinity;

    for (const f of this.fileNames) {
      const t = this.usage.get(f) ?? 0;

      if (t < oldestTick) {
        oldestTick = t;
        oldestFile = f;
      }
    }

    if (oldestFile) {
      this.files.delete(oldestFile);
      this.fileNames.delete(oldestFile);
      this.usage.delete(oldestFile);
    }
  }

  private ensureProgram() {
    try {
      this.service.getProgram();
    } catch {}
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
    this.touch(file);
    this.evictIfNeeded();

    this.ensureProgram();
  }

  removeFile(file: string) {
    file = this.normalize(file);

    this.files.delete(file);
    this.fileNames.delete(file);
    this.usage.delete(file);

    this.ensureProgram();
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
