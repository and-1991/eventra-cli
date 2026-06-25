import ts from "typescript";

import { isEventraSdkTrackCall } from "../../analysis/sdk/isEventraTrackCall";
import type { TrackedArgument, TrackSink } from "../../analysis/shared/propagation";
import type { PluginRegistry } from "../registry";
import type { SinkDetector } from "../types";

/** SDK: track(name: string, options?) — event name is always the first argument. */
function extractTrackedArguments(call: ts.CallExpression): readonly TrackedArgument[] {
  if (call.arguments.length === 0) {
    return [];
  }
  const first = call.arguments[0];
  if (ts.isObjectLiteralExpression(first)) {
    return [];
  }
  return [{ index: 0, propertyPath: [] }];
}

const eventraSdkSinkDetector: SinkDetector = {
  name: "eventra-sdk",
  detect({ call, checker }) {
    if (!isEventraSdkTrackCall(call, checker)) {
      return null;
    }
    const trackedArguments = extractTrackedArguments(call);
    if (trackedArguments.length === 0) {
      return null;
    }
    return { call, trackedArguments };
  },
};

/** Built-in sink detection for @eventra_dev/eventra-sdk (always enabled). */
export function registerEventraSdkPlugin(registry: PluginRegistry): void {
  registry.registerSinkDetector(eventraSdkSinkDetector);
}
