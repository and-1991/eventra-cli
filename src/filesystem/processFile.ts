import ts from "typescript";

export interface ProcessedFile {

  readonly fileName:
    string;

  readonly scriptKind:
    ts.ScriptKind;

  readonly content:
    string;

  readonly dependencies:
    readonly string[];
}

function getScriptKind(
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

  return ts.ScriptKind.JS;
}

export async function processFile(
  fileName: string,
  content: string,
): Promise<ProcessedFile> {

  const scriptKind =
    getScriptKind(
      fileName,
    );

  const source =
    ts.createSourceFile(

      fileName,

      content,

      ts.ScriptTarget.Latest,

      true,

      scriptKind,
    );

  const dependencies:
    string[] = [];

  for (
    const statement
    of source.statements
    ) {

    if (
      (
        ts.isImportDeclaration(
          statement,
        )
        || ts.isExportDeclaration(
          statement,
        )
      )
      && statement.moduleSpecifier
      && ts.isStringLiteral(
        statement.moduleSpecifier,
      )
    ) {

      dependencies.push(
        statement.moduleSpecifier.text,
      );
    }
  }

  return {

    fileName,

    scriptKind,

    content,

    dependencies,
  };
}
