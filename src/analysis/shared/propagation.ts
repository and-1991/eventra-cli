// src/analysis/shared/propagation.ts

import ts from "typescript";

export interface TrackedArgument {

  readonly index:
    number;

  readonly propertyPath:
    readonly string[];
}

export interface TrackSink {

  readonly call:
    ts.CallExpression;

  readonly trackedArguments:
    readonly TrackedArgument[];
}

export interface WrapperPropagation {

  //
  // source wrapper parameter
  //
  // function trackEvent(name)
  //                     ^^^^
  //

  readonly sourceParameter:
    ts.ParameterDeclaration;

  //
  // parameter index
  //

  readonly sourceParameterIndex:
    number;

  //
  // destructured access
  //
  // props.event
  // -> ["event"]
  //

  readonly propertyPath:
    readonly string[];

  //
  // semantic target
  //
  // track(name)
  //

  readonly targetNode:
    ts.Expression;
}

export interface WrapperSemanticInfo {

  readonly symbol:
    ts.Symbol;

  readonly declaration:
    ts.FunctionLikeDeclaration;

  readonly propagations:
    readonly WrapperPropagation[];
}
