import ts from "typescript";

import {ResolvedCallCache} from "../cache/resolvedCallCache";
import {ResolvedExportCache} from "../cache/resolvedExportCache";
import {resolveFunctionFromCall} from "../resolver/callResolver";
import {TrackSink, WrapperPropagation, WrapperSemanticInfo} from "../shared/propagation";
import {FileSemanticIndex} from "../shared/types";
import {WrapperRegistry} from "../symbols/wrapperRegistry";
import {analyzeWrapperPropagation} from "./analyzer/propagationAnalyzer";

/**
 * Each round can only discover wrappers one call deeper than the previous one, so this is also the
 * longest wrapper chain that is followed (`track` -> `capture` -> `posthog.capture` is two rounds).
 * Real chains are two or three deep; the bound mostly stops a cycle from spinning.
 */
const MAX_ROUNDS = 8;

/** Every call inside `fn`, nested functions included (the same reach the direct sinks have). */
function callsWithin(fn: ts.FunctionLikeDeclaration): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  /* v8 ignore else -- only functions with a body are collected */
  if (fn.body) visit(fn.body);
  return calls;
}

/**
 * A call of an already known wrapper is, for the function containing it, the same thing a call of a
 * real sink is: the arguments the wrapper forwards to its sink are the ones to follow.
 *
 * Only a plain parameter (`event`) or an object literal read by one property (`{ event }`) can be
 * followed: a wrapper that reads `options.event` from a whole object has no argument in the caller
 * to point at, so it is not chained rather than guessed.
 */
function wrapperCallAsSink(
  call: ts.CallExpression,
  self: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  registry: WrapperRegistry,
  callCache: ResolvedCallCache,
  exportCache: ResolvedExportCache,
): TrackSink | null {
  const callee = resolveFunctionFromCall(call.expression, checker, callCache, exportCache);
  if (!callee || callee === self) return null;
  const wrapper = registry.get(callee);
  if (!wrapper) return null;
  const trackedArguments = wrapper.propagations
    .filter((p) => {
      const argument = call.arguments[p.sourceParameterIndex];
      if (!argument) return false;
      return p.propertyPath.length === 0 || ts.isObjectLiteralExpression(argument);
    })
    .map((p) => ({index: p.sourceParameterIndex, propertyPath: p.propertyPath}));
  return trackedArguments.length > 0 ? {call, trackedArguments} : null;
}

const sameNode = (a: WrapperPropagation, b: WrapperPropagation): boolean =>
  a.targetNode === b.targetNode &&
  a.sourceParameterIndex === b.sourceParameterIndex &&
  a.propertyPath.join("\0") === b.propertyPath.join("\0");

/**
 * Finds the wrappers that only reach a sink through another wrapper (`trackEvent(event)` calls
 * `capture(event)`, which calls `posthog.capture(event)`), which scanning one file at a time cannot:
 * the inner wrapper may live in a file that has not been indexed yet. Repeats over every file until
 * a round finds nothing new, registers what it finds, and returns the files whose wrapper list grew.
 */
export function resolveWrapperChains(
  indices: Iterable<FileSemanticIndex>,
  checker: ts.TypeChecker,
  registry: WrapperRegistry,
  callCache: ResolvedCallCache,
  exportCache: ResolvedExportCache,
): Map<string, WrapperSemanticInfo[]> {
  const found = new Map<string, WrapperSemanticInfo[]>();
  const files = [...indices].filter((index) => (index.functions?.length ?? 0) > 0);
  // the calls of a function never change between rounds, so they are collected once; a function with
  // none (most of them) costs nothing in the rounds that follow
  const callsOf = new Map<ts.FunctionLikeDeclaration, ts.CallExpression[]>();
  for (const index of files) {
    for (const fn of index.functions!) {
      if (fn.body) {
        const calls = callsWithin(fn);
        if (calls.length > 0) callsOf.set(fn, calls);
      }
    }
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    for (const index of files) {
      for (const fn of index.functions!) {
        const calls = callsOf.get(fn);
        if (!calls) continue;
        const sinks: TrackSink[] = [];
        for (const call of calls) {
          const sink = wrapperCallAsSink(call, fn, checker, registry, callCache, exportCache);
          if (sink) sinks.push(sink);
        }
        if (sinks.length === 0) continue;
        const chained = analyzeWrapperPropagation(fn, checker, sinks);
        if (!chained) continue;

        const known = registry.get(fn);
        const added = chained.propagations.filter((p) => !known?.propagations.some((k) => sameNode(k, p)));
        if (added.length === 0) continue;

        const merged: WrapperSemanticInfo = {
          symbol: chained.symbol,
          declaration: fn,
          propagations: [...(known?.propagations ?? []), ...added],
        };
        registry.set(merged);
        const list = found.get(index.fileName) ?? [];
        found.set(index.fileName, [...list.filter((w) => w.declaration !== fn), merged]);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return found;
}
