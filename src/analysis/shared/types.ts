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

/**
 * Calls of the Eventra SDK that say whose an event is: `identify()`/`withUser()` on the real SDK class, and SDK
 * `track()` calls, with those that may pass a `userId` counted apart. Used for `check`'s hint to identify users.
 */
export interface IdentityUsage {
  readonly identityCalls: number;
  readonly trackCalls: number;
  readonly trackCallsWithUser: number;
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
  // every function declared in the file, for the cross-file wrapper chain pass
  readonly functions?: readonly ts.FunctionLikeDeclaration[];
  // how the file tells the SDK whose events they are (see IdentityUsage)
  readonly identity: IdentityUsage;
}
