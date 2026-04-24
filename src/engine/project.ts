import { Project, SourceFile, ts } from "ts-morph";
import path from "path";
import fs from "fs";

function normalize(file: string) {
  return path.resolve(file);
}

function findTsConfig(start: string): string | null {
  let dir = path.dirname(start);

  while (true) {
    const file = path.join(dir, "tsconfig.json");
    if (fs.existsSync(file)) return file;

    const parent = path.dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  return null;
}

function getScriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  if (file.endsWith(".vue")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

export class ProjectGraph {
  private project: Project;

  constructor(entry: string) {
    const tsconfig = findTsConfig(entry);

    this.project = tsconfig
      ? new Project({
        tsConfigFilePath: tsconfig,
        skipAddingFilesFromTsConfig: false,
      })
      : new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
          allowJs: true,
          jsx: ts.JsxEmit.Preserve,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          target: ts.ScriptTarget.ESNext,
        },
      });
  }

  getSource(file: string, content: string): SourceFile {
    const filePath = normalize(file);

    let source = this.project.getSourceFile(filePath);

    if (!source) {
      source = this.project.createSourceFile(filePath, content, {
        overwrite: true,
        scriptKind: getScriptKind(filePath),
      });
    } else {
      source.replaceWithText(content);
    }

    return source;
  }

  getChecker() {
    return this.project.getTypeChecker().compilerObject;
  }
}
