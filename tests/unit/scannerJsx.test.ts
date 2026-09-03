import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { scanSource } from "../../src/analysis/scanner/scanner";
import { WrapperRegistry } from "../../src/analysis/symbols/wrapperRegistry";
import { ResolvedExportCache } from "../../src/analysis/cache/resolvedExportCache";
import { PluginRegistry } from "../../src/plugin/registry";

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-jsx-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function setup(source: string) {
  const { root, cleanup } = makeProject();
  const ctx = new CompilerContext(root);
  const file = path.join(root, "a.tsx");
  ctx.updateFile(file, source);
  const checker = ctx.getChecker();
  const sourceFile = ctx.getSourceFile(file)!;
  const plugins = new PluginRegistry();
  const wrapperRegistry = new WrapperRegistry(checker, new ResolvedExportCache());
  return { cleanup, checker, sourceFile, plugins, wrapperRegistry };
}

describe("scanSource - JSX event attributes", () => {
  it("collects a literal JSX event attribute as a track call, with no plugin registered", () => {
    const { cleanup, checker, sourceFile, plugins, wrapperRegistry } = setup(`
      function Page() {
        return <Button event="checkout.cta" />;
      }
    `);
    try {
      const index = scanSource(sourceFile, checker, wrapperRegistry, plugins);
      expect(index.trackCalls).toHaveLength(1);
      expect(index.trackCalls[0].calleeText).toBe("Button");
      expect(index.trackCalls[0].trackedArguments[0].getText()).toBe('"checkout.cta"');
      // JSX attributes are never treated as call-based sinks (no wrapper propagation through them).
      expect(index.sinks).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("collects every JSX event attribute in the same file", () => {
    const { cleanup, checker, sourceFile, plugins, wrapperRegistry } = setup(`
      function Page() {
        return (
          <div>
            <Button event="button_a" />
            <Button event={"button_b"} />
          </div>
        );
      }
    `);
    try {
      const index = scanSource(sourceFile, checker, wrapperRegistry, plugins);
      const literals = index.trackCalls.map((call) => call.trackedArguments[0]?.getText());
      expect(literals.sort()).toEqual(['"button_a"', '"button_b"']);
    } finally {
      cleanup();
    }
  });
});
