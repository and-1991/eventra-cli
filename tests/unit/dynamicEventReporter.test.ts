import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";
import { createBuiltinPluginRegistry } from "../../src/plugin/loadPlugins";
import { PluginRegistry } from "../../src/plugin/registry";
import { registerConsoleDynamicEventReporterPlugin } from "../../src/plugin/builtins/consoleDynamicEventReporter";
import type { DynamicEventReporter } from "../../src/plugin/types";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-reporter-"));
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

describe("dynamic event occurrences", () => {
  it("records a call whose event name can't be resolved to a plain string literal", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          declare function getDynamicName(): string;
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("static.event");
          sdk.track(getDynamicName());
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);

      expect(engine.getAllEvents()).toContain("static.event");
      const occurrences = engine.getAllDynamicOccurrences();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.calleeText).toBe("sdk.track");
      expect(occurrences[0]?.resolvedValues).toEqual([]);
      expect(occurrences[0]?.fileName).toContain("app.ts");
    } finally {
      cleanup();
    }
  });

  it("does not flag a plain string-literal call as dynamic", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("static.event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllDynamicOccurrences()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("registerDynamicEventReporter end-to-end", () => {
  it("invokes a registered reporter with the engine's collected occurrences via runDynamicEventReporters", async () => {
    const { root, cleanup } = makeProject();
    try {
      const registry = createBuiltinPluginRegistry();
      const seen: string[] = [];
      const reporter: DynamicEventReporter = {
        name: "capture",
        report: ({ occurrences }) => {
          for (const occ of occurrences) seen.push(occ.calleeText);
        },
      };
      registry.registerDynamicEventReporter(reporter);

      const engine = new EventraEngine(root, registry);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          declare function getDynamicName(): string;
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track(getDynamicName());
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      await registry.runDynamicEventReporters(engine.getAllDynamicOccurrences());

      expect(seen).toEqual(["sdk.track"]);
    } finally {
      cleanup();
    }
  });
});

describe("built-in console dynamic event reporter", () => {
  it("prints nothing when there are no dynamic occurrences", async () => {
    const registry = new PluginRegistry();
    registerConsoleDynamicEventReporterPlugin(registry);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await registry.runDynamicEventReporters([]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("prints a header and one line per occurrence when there are dynamic occurrences", async () => {
    const registry = new PluginRegistry();
    registerConsoleDynamicEventReporterPlugin(registry);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await registry.runDynamicEventReporters([
        {
          fileName: "/app/checkout.ts",
          line: 10,
          character: 4,
          calleeText: "sdk.track",
          callText: "sdk.track(`checkout:${name}`)",
          resolvedValues: ["checkout:done"],
        },
        {
          fileName: "/app/other.ts",
          line: 3,
          character: 1,
          calleeText: "sdk.track",
          callText: "sdk.track(name)",
          resolvedValues: [],
        },
      ]);

      expect(log).toHaveBeenCalledTimes(3);
      expect(log.mock.calls[0]?.[0]).toContain("Dynamic event names:");
      expect(log.mock.calls[1]?.[0]).toContain("/app/checkout.ts:10");
      expect(log.mock.calls[1]?.[0]).toContain("resolved: checkout:done");
      expect(log.mock.calls[2]?.[0]).toContain("/app/other.ts:3");
      expect(log.mock.calls[2]?.[0]).not.toContain("resolved:");
    } finally {
      log.mockRestore();
    }
  });
});
