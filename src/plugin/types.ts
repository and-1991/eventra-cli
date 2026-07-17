import type ts from "typescript";

import type { TrackSink, WrapperSemanticInfo } from "../analysis/shared/propagation";
import type { DynamicOccurrence } from "../analysis/shared/dynamicOccurrence";

/** One logical file produced from disk (or from a preprocessor). */
export interface VirtualFile {
  readonly fileName: string;
  readonly content: string;
}

export interface FilePreprocessInput {
  readonly fileName: string;
  readonly content: string;
}

export interface FilePreprocessor {
  readonly name: string;
  /** Return true when this preprocessor should handle the file. */
  test(fileName: string): boolean;
  process(input: FilePreprocessInput): Promise<readonly VirtualFile[]>;
}

export interface SinkDetectorContext {
  readonly call: ts.CallExpression;
  readonly checker: ts.TypeChecker;
}

export interface SinkDetector {
  readonly name: string;
  detect(context: SinkDetectorContext): TrackSink | null;
}

export interface WrapperDetectorContext {
  readonly fn: ts.FunctionLikeDeclaration;
  readonly checker: ts.TypeChecker;
  readonly sinks: readonly TrackSink[];
}

/** Custom wrapper-propagation rule for a framework's non-standard wrapper conventions. */
export interface WrapperDetector {
  readonly name: string;
  detect(context: WrapperDetectorContext): WrapperSemanticInfo | null;
}

export interface DynamicEventReporterContext {
  readonly occurrences: readonly DynamicOccurrence[];
}

/** Notified with every unresolved/dynamic event-name occurrence found in a run. */
export interface DynamicEventReporter {
  readonly name: string;
  report(context: DynamicEventReporterContext): void | Promise<void>;
}

