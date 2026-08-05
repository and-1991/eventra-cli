import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EventraEngine } from "../../src/core/EventraEngine";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { EventraConfig } from "../../src/types";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eventra-sdk-plugin-"));
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

describe("built-in eventra-sdk sink detector", () => {
  it("extracts the event name from a normal sdk.track(name) call", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("checkout.completed");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);

      expect(engine.getAllEvents()).toContain("checkout.completed");
    } finally {
      cleanup();
    }
  });

  it("ignores calls that aren't a .track() call on an Eventra instance at all", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          declare function doSomethingElse(name: string): void;
          const sdk = new Eventra({ apiKey: "k" });
          doSomethingElse("not.a.track.call");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);

      expect(engine.getAllEvents()).toEqual([]);
      expect(engine.getAllDynamicOccurrences()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("does not treat a zero-argument sdk.track() call as an event sink", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track();
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);

      expect(engine.getAllEvents()).toEqual([]);
      expect(engine.getAllDynamicOccurrences()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("does not treat a misused object-literal-shaped call as an event sink", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          // Wrong API shape for track(name: string, options?) — a cast/parens
          // around the object literal must not defeat the object-literal guard.
          sdk.track({ event: "checkout.completed" } as any);
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);

      expect(engine.getAllEvents()).toEqual([]);
      expect(engine.getAllDynamicOccurrences()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
