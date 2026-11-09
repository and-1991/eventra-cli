import ts from "typescript";

/**
 * How deep a syntax tree may nest before the TypeScript binder runs out of call stack on it. A chain of about a thousand
 * `f().g()` calls or two thousand `a.b.c` links did, and that aborted the whole scan with no file named. Real code is
 * a few dozen levels deep; a left-leaning chain of `+` or `&&` is not counted (the compiler walks those in a loop).
 */
export const MAX_AST_DEPTH = 500;

// Operators whose left-leaning chain the compiler walks in a loop (`a + b + c ...`: 12,000 terms were fine). The
// logical ones (`&&`, `||`, `??`), the comma and assignments are not among them: its binder recurses on those, and
// 800 operands of `&&` overflowed the call stack and aborted the whole scan.
const FLAT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** A call stack that ran out while the file was being parsed or read: the same reason as a tree that is too deep. */
export const isStackOverflow = (err: unknown): boolean => err instanceof RangeError && /call stack/i.test(err.message);

export const TOO_DEEP_REASON = "the code nests too deeply to analyse (for example a very long chain of + or calls)";

/** The deepest nesting of a syntax tree, found without recursion so the walk itself cannot overflow. */
export function astDepth(source: ts.SourceFile): number {
  let deepest = 0;
  const stack: Array<[ts.Node, number]> = [[source, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (depth > deepest) deepest = depth;
    ts.forEachChild(node, (child) => {
      // `a + b + c` leans to the left: each step is a level of the tree but not of the work
      const sameLevel =
        ts.isBinaryExpression(node) && child === node.left && ts.isBinaryExpression(child) && FLAT_OPERATORS.has(node.operatorToken.kind);
      stack.push([child, sameLevel ? depth : depth + 1]);
    });
  }
  return deepest;
}

/** Parses `content` just to measure it: whether it is too deep to hand to the program. */
export function isTooDeep(fileName: string, content: string): boolean {
  return astDepth(ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false, getScriptKind(fileName))) > MAX_AST_DEPTH;
}

export interface ProcessedFile {
  /** How deeply the code nests (see MAX_AST_DEPTH). */
  readonly depth: number;
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
    depth: astDepth(source),
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
