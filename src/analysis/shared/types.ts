import ts from "typescript";

import {TrackSink, WrapperSemanticInfo} from "./propagation";

export interface TrackCall {
  // A real track() CallExpression, or a JSX `event="..."`/`event={expr}`
  // attribute (see jsxEventAttribute.ts) reported through the same shape -
  // both are "directly declared" event sources, never propagated through a
  // wrapper, so they share one extraction path.
  readonly node: ts.Node;
  readonly sourceFile: ts.SourceFile;
  readonly trackedArguments: readonly ts.Expression[];
  // Precomputed display text for dynamic-occurrence reporting (a call's
  // callee text, or a JSX element's tag name) - computed once here rather
  // than re-derived per node kind at report time.
  readonly calleeText: string;
}

export interface FileSemanticIndex {
  readonly fileName: string;
  readonly sourceFile: ts.SourceFile;
  // semantic sinks
  readonly sinks: readonly TrackSink[];
  // extracted track calls
  readonly trackCalls: readonly TrackCall[];
  // generic wrapper semantics
  readonly wrappers: readonly WrapperSemanticInfo[];
}
