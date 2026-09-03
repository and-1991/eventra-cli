import ts from "typescript";

import {TrackCall} from "../shared/types";

const EVENT_ATTRIBUTE_NAME = "event";

/**
 * Detects a JSX `event="literal"` / `event={expr}` attribute - the same
 * declarative-tracking convention the Vue/Svelte/Astro/Angular CLI plugins
 * already use for their own templates, recognized on any tag (plain
 * elements and components alike). No plugin or preprocessing is needed for
 * React: JSX is already part of the TypeScript AST the core walks natively,
 * so this is a plain node-kind check alongside the existing CallExpression
 * sink detection, not a separate virtual-module bridge.
 *
 * Reported through the exact same `TrackCall` shape as a real track() call:
 * a literal value resolves directly, and a dynamic expression is resolved
 * through the same checker-based pipeline as any other TS expression,
 * falling back to a dynamic occurrence (not silently dropped) when it
 * doesn't resolve to a literal.
 */
export function detectJsxEventAttribute(node: ts.Node): TrackCall | null {
  if (!ts.isJsxAttribute(node)) {
    return null;
  }
  if (!ts.isIdentifier(node.name) || node.name.text !== EVENT_ATTRIBUTE_NAME) {
    return null;
  }

  const initializer = node.initializer;
  if (!initializer) {
    // Boolean shorthand `<Button event />` - no name to extract, same as
    // the other plugins' own boolean-shorthand `event` handling.
    return null;
  }

  let value: ts.Expression;
  if (ts.isStringLiteral(initializer)) {
    // event="literal"
    value = initializer;
  } else if (ts.isJsxExpression(initializer)) {
    // event={expr} - an empty event={} has no expression to extract.
    if (!initializer.expression) {
      return null;
    }
    value = initializer.expression;
  } else {
    return null;
  }

  return {
    node,
    sourceFile: node.getSourceFile(),
    trackedArguments: [value],
    calleeText: node.parent.parent.tagName.getText(),
  };
}
