// src/analysis/shared/dynamicOccurrence.ts

import ts from "typescript";

/** A track() call site whose event-name argument could not be resolved to a plain string literal. */
export interface DynamicOccurrence {
  readonly fileName: string;
  readonly line: number;
  readonly character: number;
  readonly calleeText: string;
  readonly callText: string;
  readonly resolvedValues: readonly string[];
  /**
   * Set when the call came from a framework template (Vue, Svelte, Astro,
   * Angular): `fileName` is then the template's source file and `line` is
   * not meaningful, because the call was generated, not written.
   */
  readonly inTemplate?: boolean;
  /**
   * Set when the call is ordinary code the plugin copied out of a template (an inline handler, an
   * interpolation): `fileName` is the template's source file and `line` is not meaningful.
   */
  readonly inTemplateCode?: boolean;
  /** The template expression behind `event=...`, for template occurrences. */
  readonly eventExpression?: string;
  /**
   * Set when the call sits in a generated module that is not a plain source
   * file (for example the component class copied into an Angular template
   * module): `line` points into generated text and is not meaningful.
   */
  readonly inGeneratedCode?: boolean;
}

const CALL_TEXT_MAX_LENGTH = 120;

// `node` is a CallExpression for a real track() call, or a JsxAttribute for
// a JSX `event="..."`/`event={expr}` binding (see jsxEventAttribute.ts) -
// `calleeText` is supplied by the caller since it's derived differently per
// node kind (a call's callee text vs. a JSX element's tag name).
export function recordDynamicOccurrence(node: ts.Node, calleeText: string, resolvedValues: readonly string[], out: DynamicOccurrence[]): void {
  out.push(occurrenceAt(node, calleeText, resolvedValues));
}

/**
 * A track() call whose event name is a plain string the CLI cannot accept (too long, or with characters
 * outside the allowed set). It is not added to the events; this is what tells the user it was seen.
 */
export interface RejectedName extends DynamicOccurrence {
  readonly name: string;
  readonly reason: string;
}

const NAME_MAX_LENGTH = 60;

export function recordRejectedName(node: ts.Node, calleeText: string, name: string, reason: string, out: RejectedName[]): void {
  out.push({
    ...occurrenceAt(node, calleeText, [name]),
    name: name.length > NAME_MAX_LENGTH ? `${name.slice(0, NAME_MAX_LENGTH)}…` : name,
    reason,
  });
}

function occurrenceAt(node: ts.Node, calleeText: string, resolvedValues: readonly string[]): DynamicOccurrence {
  const sourceFile = node.getSourceFile();
  const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  const callText = node.getText(sourceFile);
  return {
    fileName: sourceFile.fileName,
    line: line + 1,
    character,
    calleeText,
    callText: callText.length > CALL_TEXT_MAX_LENGTH ? `${callText.slice(0, CALL_TEXT_MAX_LENGTH)}…` : callText,
    resolvedValues,
  };
}
