import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EventraConfig } from "../../src/types";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import { registerExternalCliPlugin } from "../../src/plugin/adapters/external";
import type { ExternalCliPlugin } from "../../src/plugin/adapters/external";

const CONFIG: EventraConfig = {
  apiKey: "",
  endpoint: "",
  events: [],
  functionWrappers: [],
  sync: {
    include: ["**/*.ts"],
    exclude: ["node_modules", "dist", ".next", ".git"],
  },
};

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-dynamic-sink-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const testPlugin: ExternalCliPlugin = {
  id: "test-dynamic",
  includeGlobs: ["**/*.ts"],
  staticSinks: [
    { id: "test-dynamic-sink", callee: "__test_dynamic_sink__", eventNameArgumentIndex: 0 },
  ],
  match: () => false,
  transform: async ({ path: p, source }) => ({ modules: [{ path: p, content: source }] }),
};

describe("external plugin static sink with a non-literal argument", () => {
  it("still registers a TrackSink and lets the resolver flag it as a dynamic occurrence", async () => {
    const { root, cleanup } = makeProject();
    try {
      const registry = createBuiltinPluginRegistry();
      registerExternalCliPlugin(testPlugin, registry);

      const engine = new EventraEngine(root, registry);
      engine.beginPreload();
      const fileName = path.join(root, "app.ts");
      await engine.preloadFile(
        fileName,
        `
          declare function __test_dynamic_sink__(name: string): void;
          declare function getDynamicName(): string;
          __test_dynamic_sink__("literal_ok");
          __test_dynamic_sink__(getDynamicName());
        `,
      );
      engine.endPreload();

      await engine.runFullAnalysis([fileName], CONFIG);

      expect(engine.getAllEvents()).toContain("literal_ok");
      const occurrences = engine.getAllDynamicOccurrences();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.calleeText).toBe("__test_dynamic_sink__");
    } finally {
      cleanup();
    }
  });
});
