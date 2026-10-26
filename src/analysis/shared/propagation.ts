// src/analysis/shared/propagation.ts

import ts from "typescript";

import {WrapperCallSite} from "./callSite";

export interface TrackedArgument {
  readonly index: number;
  readonly propertyPath: readonly string[];
}

export interface TrackSink {
  // a JSX element is the call of its component, with the props object as its one argument
  readonly call: WrapperCallSite;
  readonly trackedArguments: readonly TrackedArgument[];
}

export interface WrapperPropagation {
  // source wrapper parameter
  // function trackEvent(name)
  //                     ^^^^
  readonly sourceParameter: ts.ParameterDeclaration;
  // parameter index
  readonly sourceParameterIndex: number;
  // destructured access
  // props.event
  // -> ["event"]
  readonly propertyPath: readonly string[];
  // semantic target
  // track(name)
  readonly targetNode: ts.Expression;
  // The sink reads the parameter through a local alias (`const { track } = props`), so `targetNode`
  // is not the parameter itself: the value is read off the call site's argument by `propertyPath` instead.
  readonly viaAlias?: boolean;
}

export interface WrapperSemanticInfo {
  readonly symbol: ts.Symbol;
  readonly declaration: ts.FunctionLikeDeclaration;
  readonly propagations: readonly WrapperPropagation[];
}
