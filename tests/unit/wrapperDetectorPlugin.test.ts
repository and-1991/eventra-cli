import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import { getFunctionSymbol } from "../../src/analysis/symbols/symbolUtils";
import type { WrapperDetector } from "../../src/plugin/types";

const SDK_TYPES = "__eventra_sdk_types__.d.ts";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: {
    include: ["**/*.{ts,tsx,js,jsx}"],
    exclude: ["node_modules", "dist", ".next", ".git"],
  },
};

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-detector-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function preloadEngine(
  engine: EventraEngine,
  root: string,
  files: Record<string, string>,
): Promise<string[]> {
  engine.beginPreload();
  await engine.preloadFile(SDK_TYPES, EVENTRA_SDK_SHIM);
  const fileNames: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    await engine.preloadFile(abs, content);
    fileNames.push(abs);
  }
  engine.endPreload();
  return [SDK_TYPES, ...fileNames];
}

/**
 * Recognizes `function trackFeature(name) { sdk.track(`prefix:${name}`) }` — a template-literal
 * sink argument the built-in analyzer's fixed patterns (identifier / property-access / object
 * literal) don't cover, since `collectPropagations` never inspects `ts.TemplateExpression` args.
 */
function createTemplateWrapperDetector(): WrapperDetector {
  return {
    name: "template-literal-wrapper",
    detect({ fn, checker, sinks }) {
      if (sinks.length !== 1 || fn.parameters.length !== 1) return null;
      const [param] = fn.parameters;
      if (!ts.isIdentifier(param.name)) return null;
      const paramName = param.name.text;

      const tracked = sinks[0].trackedArguments[0];
      if (!tracked) return null;
      const argument = sinks[0].call.arguments[tracked.index];
      if (!argument || !ts.isTemplateExpression(argument)) return null;

      const usesParam = argument.templateSpans.some(
        (span) => ts.isIdentifier(span.expression) && span.expression.text === paramName,
      );
      if (!usesParam) return null;

      const symbol = getFunctionSymbol(fn, checker);
      if (!symbol) return null;

      return {
        symbol,
        declaration: fn,
        propagations: [
          {
            sourceParameter: param,
            sourceParameterIndex: 0,
            propertyPath: [],
            targetNode: argument,
          },
        ],
      };
    },
  };
}

describe("registerWrapperDetector", () => {
  it("lets a plugin propagate through a wrapper shape the built-in analyzer doesn't cover", async () => {
    const { root, cleanup } = makeProject();
    try {
      const registry = createBuiltinPluginRegistry();
      registry.registerWrapperDetector(createTemplateWrapperDetector());
      const engine = new EventraEngine(root, registry);

      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function trackFeature(name: string) {
            sdk.track(\`checkout:\${name}\`);
          }
        `,
        "app.ts": `
          import { trackFeature } from "./tracker";
          trackFeature("done");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toContain("checkout:done");
    } finally {
      cleanup();
    }
  });

  it("falls back to the built-in analyzer for wrapper shapes the plugin doesn't match", async () => {
    const { root, cleanup } = makeProject();
    try {
      const registry = createBuiltinPluginRegistry();
      registry.registerWrapperDetector(createTemplateWrapperDetector());
      const engine = new EventraEngine(root, registry);

      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function trackFeature(name: string) {
            sdk.track(name);
          }
        `,
        "app.ts": `
          import { trackFeature } from "./tracker";
          trackFeature("user.signup");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toContain("user.signup");
    } finally {
      cleanup();
    }
  });

  it("without the plugin registered, the built-in analyzer alone misses the template-literal shape", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);

      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function trackFeature(name: string) {
            sdk.track(\`checkout:\${name}\`);
          }
        `,
        "app.ts": `
          import { trackFeature } from "./tracker";
          trackFeature("done");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).not.toContain("checkout:done");
    } finally {
      cleanup();
    }
  });
});
