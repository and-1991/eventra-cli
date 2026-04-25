import ts from "typescript";
import fs from "fs";

export class TSService {
  private files = new Map<string, { version: number; content: string }>();
  private service: ts.LanguageService;

  constructor(private root: string) {
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...this.files.keys()],
      getScriptVersion: (file) =>
        this.files.get(file)?.version.toString() ?? "0",
      getScriptSnapshot: (file) => {
        const f = this.files.get(file);

        if (f) {
          return ts.ScriptSnapshot.fromString(f.content);
        }

        if (fs.existsSync(file)) {
          return ts.ScriptSnapshot.fromString(
            fs.readFileSync(file, "utf-8" as BufferEncoding)
          );
        }

        return undefined;
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => ({
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      }),
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),

      readFile: (fileName: string, encoding?: string) => {
        try {
          return fs.readFileSync(fileName, encoding as BufferEncoding);
        } catch (err) {
          return undefined;
        }
      },

      fileExists: fs.existsSync,
    };

    this.service = ts.createLanguageService(host);
  }

  updateFile(file: string, content: string) {
    const prev = this.files.get(file);

    this.files.set(file, {
      content,
      version: prev ? prev.version + 1 : 1,
    });
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
}
