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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-file-sdk-"));
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

// Regression coverage for a gap where `.track()`/wrapper calls were only detected
// when the literal call site's *own* file also had an `import ... from
// "@eventra_dev/eventra-sdk"` statement — even though the receiver already resolves
// to a real Eventra instance across files via the type checker.
describe("cross-file SDK instance detection", () => {
  it("detects a direct .track() call on an instance imported from another file", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);

      const files = await preloadEngine(engine, root, {
        "analytics.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          export const analytics = new Eventra({ apiKey: "k" });
        `,
        "feature.ts": `
          import { analytics } from "./analytics";
          analytics.track("cross_file_direct_event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toContain("cross_file_direct_event");
      expect(engine.getAllDynamicOccurrences()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("detects a wrapper function whose own file has no direct SDK import, called from a third file", async () => {
    const { root, cleanup } = makeProject();
    try {
      const engine = new EventraEngine(root);

      const files = await preloadEngine(engine, root, {
        "eventra-instance.ts": `
          import { Eventra } from "@eventra_dev/eventra-sdk";
          export const analytics = new Eventra({ apiKey: "k" });
        `,
        "analytics-helpers.ts": `
          import { analytics } from "./eventra-instance";
          export function trackFeature(name: string) {
            analytics.track(name);
          }
        `,
        "feature.ts": `
          import { trackFeature } from "./analytics-helpers";
          trackFeature("cross_file_wrapper_event");
        `,
      });

      await engine.runFullAnalysis(files, CONFIG);
      expect(engine.getAllEvents()).toContain("cross_file_wrapper_event");
      expect(engine.getAllFunctionWrappers()).toContain("trackFeature");
    } finally {
      cleanup();
    }
  });
});
