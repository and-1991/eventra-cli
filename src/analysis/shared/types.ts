import ts from "typescript";

import {
  TrackSink,
  WrapperSemanticInfo,
} from "./propagation";

export interface TrackCall {

  readonly node:
    ts.CallExpression;

  readonly sourceFile:
    ts.SourceFile;

  readonly trackedArguments:
    readonly ts.Expression[];
}

export interface FileSemanticIndex {

  readonly fileName:
    string;

  readonly sourceFile:
    ts.SourceFile;

  //
  // semantic sinks
  //

  readonly sinks:
    readonly TrackSink[];

  //
  // extracted track calls
  //

  readonly trackCalls:
    readonly TrackCall[];

  //
  // generic wrapper semantics
  //

  readonly wrappers:
    readonly WrapperSemanticInfo[];
}
