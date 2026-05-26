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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-"));
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

describe("EventraEngine", () => {
  it("extracts direct track() calls from a single file", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("checkout.completed");
          sdk.track("app.loaded");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);

      expect(engine.getAllEvents().sort()).toEqual([
        "app.loaded",
        "checkout.completed",
      ]);
    } finally {
      cleanup();
    }
  });

  it("ignores track() calls from non-SDK modules", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          import { analytics } from "./fake-analytics";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("real.event");
          analytics.track("fake.event");
          // generic call
          (function track(name: string) {})("global.fake");
        `,
        "fake-analytics.ts": `
          export const analytics = {
            track(name: string) { /* noop */ },
          };
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      const events = engine.getAllEvents();
      expect(events).toContain("real.event");
      expect(events).not.toContain("fake.event");
      expect(events).not.toContain("global.fake");
    } finally {
      cleanup();
    }
  });

  it("resolves wrappers across files (cross-file propagation)", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
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
          trackFeature("user.logout");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents().sort()).toEqual([
        "user.logout",
        "user.signup",
      ]);
      expect(engine.getAllFunctionWrappers()).toContain("trackFeature");
    } finally {
      cleanup();
    }
  });

  it("updateFile() reflects changes in subsequent extractions", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "app.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("v1.event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toEqual(["v1.event"]);

      const appPath = path.join(root, "app.ts");
      await engine.updateFile(
        appPath,
        `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          sdk.track("v2.event");
          sdk.track("extra.event");
        `,
        CONFIG,
      );

      expect(engine.getAllEvents().sort()).toEqual(["extra.event", "v2.event"]);
    } finally {
      cleanup();
    }
  });

  it("updateFile() on a wrapper file repropagates events in call sites", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
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
          trackFeature("initial");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toEqual(["initial"]);

      const trackerPath = path.join(root, "tracker.ts");
      await engine.updateFile(
        trackerPath,
        `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          // add an internal call
          export function trackFeature(name: string) {
            sdk.track(name);
            sdk.track("internal.from.wrapper");
          }
        `,
        CONFIG,
      );

      const events = engine.getAllEvents();
      expect(events).toContain("initial");
      expect(events).toContain("internal.from.wrapper");
    } finally {
      cleanup();
    }
  });

  it("removeFile() drops events from the gone file and reanalyzes dependents", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function trackFeature(name: string) { sdk.track(name); }
        `,
        "app.ts": `
          import { trackFeature } from "./tracker";
          trackFeature("call.site.event");
        `,
        "standalone.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const local = new Eventra({ apiKey: "k" });
          local.track("standalone.event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toContain("call.site.event");
      expect(engine.getAllEvents()).toContain("standalone.event");

      const standalonePath = path.join(root, "standalone.ts");
      await engine.removeFile(standalonePath, CONFIG);

      const after = engine.getAllEvents();
      expect(after).not.toContain("standalone.event");
      // call-site event must still be detected
      expect(after).toContain("call.site.event");
    } finally {
      cleanup();
    }
  });

  it("getAllFunctionWrappers filters out anonymous / internal names", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);
      const files = await preloadEngine(engine, root, {
        "tracker.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          const sdk = new Eventra({ apiKey: "k" });
          export function publicWrapper(name: string) { sdk.track(name); }
        `,
        "app.ts": `
          import { publicWrapper } from "./tracker";
          publicWrapper("a");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      const wrappers = engine.getAllFunctionWrappers();
      expect(wrappers).toContain("publicWrapper");
      // sanity: no synthetic names
      expect(wrappers.every((w) => !w.startsWith("__"))).toBe(true);
      expect(wrappers.every((w) => w !== "anonymous")).toBe(true);
    } finally {
      cleanup();
    }
  });
});
