import ts from "typescript";

import { TrackedArgument, TrackSink } from "../shared/propagation";
import { isEventraSdkTrackCall } from "../sdk/isEventraTrackCall";

/** SDK: track(name: string, options?) — event name is always the first argument. */
function extractTrackedArguments(call: ts.CallExpression): readonly TrackedArgument[] {
  if (call.arguments.length === 0) {
    return [];
  }
  const first = call.arguments[0];
  if (ts.isObjectLiteralExpression(first)) {
    return [];
  }
  return [
    {
      index: 0,
      propertyPath: [],
    },
  ];
}

export function detectTrackSink(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): TrackSink | null {
  if (!isEventraSdkTrackCall(call, checker)) {
    return null;
  }
  const trackedArguments = extractTrackedArguments(call);
  if (trackedArguments.length === 0) {
    return null;
  }
  return {
    call,
    trackedArguments,
  };
}
