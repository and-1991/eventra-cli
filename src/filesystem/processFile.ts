import ts from "typescript";

export interface ProcessedFile {
  readonly fileName: string;
  readonly scriptKind: ts.ScriptKind;
  readonly content: string;
  readonly dependencies: readonly string[];
  /** The first syntax error the TypeScript parser reported, if any. The file is still analysed. */
  readonly syntaxError?: { readonly line: number; readonly message: string };
}

function getScriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (fileName.endsWith(".ts")) {
    return ts.ScriptKind.TS;
  }
  if (fileName.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

export async function processFile(fileName: string, content: string): Promise<ProcessedFile> {
  const scriptKind = getScriptKind(fileName);
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind,);
  const dependencies: string[] = [];

  for (const statement of source.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      dependencies.push(statement.moduleSpecifier.text);
    }
  }

  return {
    fileName,
    scriptKind,
    content,
    dependencies,
    ...firstSyntaxError(source),
  };
}

// `parseDiagnostics` is not in the public typings; it holds only real syntax errors (the checker's
// own findings, such as type errors, are not parse diagnostics)
function firstSyntaxError(source: ts.SourceFile): Pick<ProcessedFile, "syntaxError"> {
  const [first] = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (!first) {
    return {};
  }
  return {
    syntaxError: {
      line: ts.getLineAndCharacterOfPosition(source, first.start!).line + 1,
      message: ts.flattenDiagnosticMessageText(first.messageText, " "),
    },
  };
}
