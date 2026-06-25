import ts from "typescript";

import type { PluginRegistry } from "../../plugin/registry";
import type { TrackSink } from "../shared/propagation";

export function detectTrackSink(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  plugins: PluginRegistry,
): TrackSink | null {
  return plugins.detectSink({ call, checker });
}
