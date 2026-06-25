import ts from "typescript";

import type { PluginRegistry } from "../registry";
import type { SinkDetector, VirtualFile } from "../types";

/** Duck-typed mirror of external CLI plugin static sink descriptors. */
export interface ExternalPluginStaticCalleeSink {
  readonly id: string;
  readonly callee: string;
  readonly eventNameArgumentIndex: number;
}

/** Duck-typed mirror of external CLI plugins (e.g. `@eventra_dev/cli-plugin-vue`). */
export interface ExternalCliPlugin {
  readonly id: string;
  readonly version?: string;
  readonly includeGlobs: readonly string[];
  readonly staticSinks?: readonly ExternalPluginStaticCalleeSink[];
  match(path: string): boolean;
  transform(input: {
    readonly path: string;
    readonly source: string;
  }): Promise<{
    readonly modules: readonly { readonly path: string; readonly content: string }[];
  }>;
}

function isStaticSink(value: unknown): value is ExternalPluginStaticCalleeSink {
  if (!value || typeof value !== "object") {
    return false;
  }
  const sink = value as ExternalPluginStaticCalleeSink;
  return (
    typeof sink.id === "string" &&
    sink.id.trim().length > 0 &&
    typeof sink.callee === "string" &&
    sink.callee.trim().length > 0 &&
    Number.isInteger(sink.eventNameArgumentIndex) &&
    sink.eventNameArgumentIndex >= 0
  );
}

export function isExternalCliPlugin(value: unknown): value is ExternalCliPlugin {
  if (!value || typeof value !== "object") {
    return false;
  }
  const plugin = value as ExternalCliPlugin;
  if (typeof plugin.id !== "string" || plugin.id.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(plugin.includeGlobs) || plugin.includeGlobs.some((g) => typeof g !== "string")) {
    return false;
  }
  if (plugin.staticSinks !== undefined) {
    if (!Array.isArray(plugin.staticSinks) || plugin.staticSinks.some((s) => !isStaticSink(s))) {
      return false;
    }
  }
  return typeof plugin.match === "function" && typeof plugin.transform === "function";
}

function createStaticCalleeSinkDetector(
  sink: ExternalPluginStaticCalleeSink,
): SinkDetector {
  return {
    name: sink.id,
    detect({ call }) {
      const expr = call.expression;
      if (!ts.isIdentifier(expr) || expr.text !== sink.callee) {
        return null;
      }
      const argIndex = sink.eventNameArgumentIndex;
      if (call.arguments.length <= argIndex) {
        return null;
      }
      const arg = call.arguments[argIndex];
      if (!ts.isStringLiteral(arg)) {
        return null;
      }
      return {
        call,
        trackedArguments: [{ index: argIndex, propertyPath: [] }],
      };
    },
  };
}

function mapTransformModules(
  plugin: ExternalCliPlugin,
  fileName: string,
  modules: unknown,
): VirtualFile[] {
  if (!Array.isArray(modules)) {
    throw new Error(`Plugin "${plugin.id}" returned invalid transform result for ${fileName}`);
  }
  return modules.map((module, index) => {
    if (!module || typeof module !== "object") {
      throw new Error(`Plugin "${plugin.id}" module at index ${index} is invalid`);
    }
    const { path: modulePath, content } = module as { path?: unknown; content?: unknown };
    if (typeof modulePath !== "string" || typeof content !== "string") {
      throw new Error(
        `Plugin "${plugin.id}" module at index ${index} must have string path and content`,
      );
    }
    return { fileName: modulePath, content };
  });
}

/** Maps an external plugin contract into the internal PluginRegistry hooks. */
export function registerExternalCliPlugin(
  plugin: ExternalCliPlugin,
  registry: PluginRegistry,
): void {
  for (const glob of plugin.includeGlobs) {
    registry.registerIncludePattern(glob);
  }

  registry.registerFilePreprocessor({
    name: plugin.id,
    test: (fileName) => plugin.match(fileName),
    process: async ({ fileName, content }) => {
      let result: { modules: unknown };
      try {
        result = await plugin.transform({ path: fileName, source: content });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Plugin "${plugin.id}" failed to transform ${fileName}: ${message}`);
      }
      return mapTransformModules(plugin, fileName, result?.modules);
    },
  });

  for (const sink of plugin.staticSinks ?? []) {
    if (!isStaticSink(sink)) {
      throw new Error(`Plugin "${plugin.id}" has invalid staticSink (id, callee, eventNameArgumentIndex)`);
    }
    registry.registerSinkDetector(createStaticCalleeSinkDetector(sink));
  }
}
