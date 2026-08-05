import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";

export function makeProject(prefix = "resolver-"): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export interface Project {
  ctx: CompilerContext;
  root: string;
  cleanup: () => void;
  file(name: string): ts.SourceFile;
  checker: ts.TypeChecker;
}

/** Builds a real CompilerContext backed by real files on disk, all written before the program is built. */
export function buildProject(files: Record<string, string>, prefix = "resolver-"): Project {
  const { root, cleanup } = makeProject(prefix);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const ctx = new CompilerContext(root);
  // stage+flush every file so the real ts.Program includes them all at once
  for (const rel of Object.keys(files)) {
    ctx.stageFile(path.join(root, rel), files[rel]);
  }
  ctx.flushUpdates();

  return {
    ctx,
    root,
    cleanup,
    checker: ctx.getChecker(),
    file(name: string): ts.SourceFile {
      const sf = ctx.getSourceFile(path.join(root, name));
      if (!sf) {
        throw new Error(`source file not found: ${name}`);
      }
      return sf;
    },
  };
}

/** Pre-order depth-first search for the first node matching `predicate`. */
export function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T | undefined {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Pre-order depth-first search collecting every node matching `predicate`. */
export function findAllNodes<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Finds the Nth (0-indexed) call expression whose callee text contains `needle`. */
export function findCall(root: ts.Node, needle: string, occurrence = 0): ts.CallExpression {
  // Callers pass e.g. "track(" for readability; the callee's own text never
  // includes the parens, so strip a trailing "(" before matching.
  const calleeNeedle = needle.endsWith("(") ? needle.slice(0, -1) : needle;
  const calls = findAllNodes(root, ts.isCallExpression).filter((call) =>
    call.expression.getText().includes(calleeNeedle),
  );
  const call = calls[occurrence];
  if (!call) {
    throw new Error(`no call expression matching "${needle}" (occurrence ${occurrence}) found`);
  }
  return call;
}

/** Finds the Nth (0-indexed) argument of the Nth call expression matching `needle`. */
export function findCallArgument(
  root: ts.Node,
  needle: string,
  argIndex = 0,
  occurrence = 0,
): ts.Expression {
  const call = findCall(root, needle, occurrence);
  const argument = call.arguments[argIndex];
  if (!argument) {
    throw new Error(`call matching "${needle}" has no argument at index ${argIndex}`);
  }
  return argument;
}

/** Finds a top-level (or nested) identifier by exact text. */
export function findIdentifier(root: ts.Node, text: string, occurrence = 0): ts.Identifier {
  const identifiers = findAllNodes(
    root,
    (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === text,
  );
  const identifier = identifiers[occurrence];
  if (!identifier) {
    throw new Error(`no identifier "${text}" (occurrence ${occurrence}) found`);
  }
  return identifier;
}
