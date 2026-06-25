import type ts from "typescript";

import type { TrackSink } from "../analysis/shared/propagation";

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

