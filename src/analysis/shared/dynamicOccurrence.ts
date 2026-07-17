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
}

const CALL_TEXT_MAX_LENGTH = 120;

export function recordDynamicOccurrence(call: ts.CallExpression, resolvedValues: readonly string[], out: DynamicOccurrence[]): void {
  const sourceFile = call.getSourceFile();
  const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, call.getStart(sourceFile));
  const callText = call.getText(sourceFile);
  out.push({
    fileName: sourceFile.fileName,
    line: line + 1,
    character,
    calleeText: call.expression.getText(sourceFile),
    callText: callText.length > CALL_TEXT_MAX_LENGTH ? `${callText.slice(0, CALL_TEXT_MAX_LENGTH)}…` : callText,
    resolvedValues,
  });
}
