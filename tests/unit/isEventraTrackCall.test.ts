import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";

import { CompilerContext } from "../../src/compiler/compilerContext";
import { EVENTRA_SDK_SHIM } from "../../src/analysis/sdk/eventraSdk";
import { isEventraSdkTrackCall } from "../../src/analysis/sdk/isEventraTrackCall";

// This suite extends coverage of isEventraSdkTrackCall beyond what
// crossFileSdkDetection.test.ts already exercises (the cross-file
// `.track()`/wrapper detection fix from AUDIT-CLI-SDK.md #9). That file
// covers the cross-file identifier/wrapper path end-to-end via EventraEngine;
// this file targets isEventraSdkTrackCall directly (call, checker) => boolean
// and sweeps the receiver/callee shapes the function itself branches on:
// direct `new Eventra().track()` chains, call-wrapped-new receivers, element
// access callees, parameter/property fallbacks, and non-Eventra look-alikes.

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isEventraTrackCall-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A real npm install of @eventra_dev/eventra-sdk resolves through
 * node_modules, so its own declaration file's path always contains
 * "@eventra_dev/eventra-sdk" — that substring match
 * (isEventraClassDeclaration in isEventraTrackCall.ts) is how a *direct*
 * `new Eventra(...).track(...)` chain (no intermediate variable) gets
 * detected, since that receiver shape bypasses the generic
 * type-string fallback entirely. Placing the shim at a matching path
 * here mirrors that real resolution layout instead of the shorter
 * "__eventra_sdk_types__.d.ts" virtual name other suites use (which is
 * sufficient for *those* suites only because they all go through an
 * intermediate variable, hitting the generic type-string fallback instead).
 */
function shimPath(root: string): string {
  return path.join(root, "node_modules", "@eventra_dev", "eventra-sdk", "dist", "index.d.ts");
}

function setup(root: string, sourceFiles: Record<string, string>): { ctx: CompilerContext; checker: ts.TypeChecker } {
  const ctx = new CompilerContext(root);
  const shimFile = shimPath(root);
  fs.mkdirSync(path.dirname(shimFile), { recursive: true });
  ctx.updateFile(shimFile, EVENTRA_SDK_SHIM);
  for (const [rel, content] of Object.entries(sourceFiles)) {
    ctx.updateFile(path.join(root, rel), content);
  }
  return { ctx, checker: ctx.getChecker() };
}

function findCalls(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      calls.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return calls;
}

/**
 * The call under test is always written as the *last* top-level statement in
 * each fixture, with any setup (e.g. `const sdk: any = new Eventra(...);`)
 * on earlier statements — scoping the search to only the last statement
 * avoids accidentally picking up a call nested inside that earlier setup
 * (e.g. the `new Eventra(...)()` call-wrapped-new-expression itself is also
 * a CallExpression) instead of the intended `sdk.track(...)`/etc. call.
 */
function lastStatementCallResult(root: string, files: Record<string, string>, entry: string): boolean {
  const { ctx, checker } = setup(root, files);
  const sourceFile = ctx.getSourceFile(path.join(root, entry))!;
  const lastStatement = sourceFile.statements[sourceFile.statements.length - 1];
  const [call] = findCalls(lastStatement);
  return isEventraSdkTrackCall(call, checker);
}

describe("isEventraSdkTrackCall", () => {
  it("detects instance.track(...) via a variable initialized from a named import", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk = new Eventra({ apiKey: "k" });
            sdk.track("via_variable");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("detects a direct new Eventra(...).track(...) chain with no intermediate variable", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            new Eventra({ apiKey: "k" }).track("direct_chain");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not detect a default-imported Eventra used in a direct chain (documents current behavior)", () => {
    const { root, cleanup } = makeProject();
    try {
      // Unlike the named-import case, a default import's local symbol aliases to the ambient
      // `declare module` block itself (there's no real default export in the shim to alias to),
      // not to the `Eventra` ClassDeclaration — so isEventraClassDeclaration's file-path check
      // never runs against a matching declaration for this receiver shape. This asserts the
      // isEventraSdkTrackCall's actual current behavior for a direct chain off a default import,
      // not a claim that it's the intended/correct outcome.
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import Eventra from "@eventra_dev/eventra-sdk";
            new Eventra({ apiKey: "k" }).track("default_import_chain");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("detects a call-wrapped new-expression receiver (new Eventra(...)().track(...))", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            new Eventra({ apiKey: "k" })().track("call_wrapped_new");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("detects a variable whose type annotation forces `any` but whose initializer is new Eventra(...)", () => {
    const { root, cleanup } = makeProject();
    try {
      // An explicit `: any` annotation overrides the inferred "Eventra" display type at the
      // usage site, so the generic type-string fallback fails here — this is the one
      // realistic shape that actually reaches the variable-declaration-initializer fallback
      // (`ts.isNewExpression(decl.initializer) && isEventraNewExpression(...)`) instead of
      // being caught earlier by the generic check every other variable-based test hits.
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk: any = new Eventra({ apiKey: "k" });
            sdk.track("any_annotated_new");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("detects a variable annotated `any` and initialized from a call-wrapped new-expression", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk: any = new Eventra({ apiKey: "k" })();
            sdk.track("any_annotated_call_wrapped_new");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not match a coincidental .track() method on an `any`-annotated non-Eventra instance", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            class Logger {
              track(name: string): void {}
            }
            const sdk: any = new Logger();
            sdk.track("not_eventra");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("does not match a coincidental .track() method on a call-wrapped non-Eventra new-expression", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            class Logger {
              track(name: string): void {}
            }
            const sdk: any = new Logger()();
            sdk.track("not_eventra");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("does not match a plain object with a coincidental track() method", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            const logger = { track(name: string) {} };
            logger.track("not_eventra");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("does not match a call to a differently named method", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk = new Eventra({ apiKey: "k" });
            sdk.identify("user_1");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("does not match a bare identifier call (no receiver at all)", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            function track(name: string) {}
            track("no_receiver");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("detects instance.track(...) through an element-access callee (sdk[\"track\"](...))", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk = new Eventra({ apiKey: "k" });
            sdk["track"]("element_access");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not match an element-access callee keyed by a different string literal", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk = new Eventra({ apiKey: "k" });
            sdk["identify"]("element_access_other");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("does not match an element-access callee keyed by a non-string-literal expression", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk = new Eventra({ apiKey: "k" });
            const method = "track";
            sdk[method]("dynamic_key");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("detects instance.track(...) via optional chaining on the receiver and the callee", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const sdk: Eventra | undefined = new Eventra({ apiKey: "k" });
            sdk?.track("optional_chain");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("detects instance.track(...) reached through nested property access (state.services.analytics.track)", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            const state = { services: { analytics: new Eventra({ apiKey: "k" }) } };
            state.services.analytics.track("nested_property_access");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not match nested property access that never resolves to an Eventra instance", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            const state = { services: { logger: { track(name: string) {} } } };
            state.services.logger.track("nested_non_eventra");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("detects a receiver typed via a function parameter annotation", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            function wrap(sdk: Eventra) {
              sdk.track("param_typed");
            }
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not detect a direct chain off a constructor with no resolvable symbol", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            // @ts-ignore
            new UndeclaredCtor().track("undeclared_ctor");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("does not detect a namespace-qualified constructor (new ns.Eventra(...))", () => {
    const { root, cleanup } = makeProject();
    try {
      // isEventraNewExpression only handles a bare identifier constructor
      // target (`new Eventra(...)`) - a namespace-qualified one is a
      // PropertyAccessExpression, so it falls through to `false` here. This
      // documents current behavior, not a claim that it's the intended
      // outcome (mirrors the default-import gap documented above).
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import * as sdkNs from "@eventra_dev/eventra-sdk";
            new sdkNs.Eventra({ apiKey: "k" }).track("namespace_qualified_new");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("does not match a receiver identifier with no resolvable symbol", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            // @ts-ignore
            UNDECLARED_SDK.track("undeclared_receiver");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("detects a parameter declared as a union including Eventra, even when narrowed away from Eventra at this call site (documents current behavior)", () => {
    const { root, cleanup } = makeProject();
    try {
      // Inside the `instanceof Logger` guard, the usage-site type of `sdk`
      // is narrowed to just `Logger` (failing the generic type-string
      // check), so this falls back to the parameter-declaration fallback -
      // which reads the *declared* (unnarrowed) union type off `decl.type`
      // and matches on the Eventra member. This is a real, if surprising,
      // false positive from the coarser declaration-based fallback, not the
      // intended detection target (a Logger instance is what's actually
      // calling .track() here).
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            class Logger { track(name: string): void {} }
            function wrap(sdk: Eventra | Logger) {
              if (sdk instanceof Logger) {
                sdk.track("param_narrowed_away_from_eventra");
              }
            }
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("detects a receiver typed via a class property annotation, accessed through `this.`", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            class Service {
              sdk: Eventra;
              constructor(sdk: Eventra) {
                this.sdk = sdk;
              }
              run() {
                this.sdk.track("property_typed");
              }
            }
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not match a generic parameter merely constrained to Eventra (constraint isn't resolved as the receiver's own type)", () => {
    const { root, cleanup } = makeProject();
    try {
      // `T` (the type parameter itself) is what the checker reports for both
      // the parameter's declared type node and the identifier's resolved type
      // at the usage site — neither resolves through to the `Eventra`
      // constraint, so this deliberately exercises the parameter-declaration
      // fallback's `false` path (decl.type is present but doesn't look like
      // Eventra) rather than matching.
      const result = lastStatementCallResult(
        root,
        {
          "app.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            function wrap<T extends Eventra>(sdk: T) {
              sdk.track("generic_constraint");
            }
          `,
        },
        "app.ts",
      );
      expect(result).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("detects instance.track(...) across files through a re-exporting barrel module", () => {
    const { root, cleanup } = makeProject();
    try {
      const result = lastStatementCallResult(
        root,
        {
          "instance.ts": `
            import { Eventra } from "@eventra_dev/eventra-sdk";
            export const analytics = new Eventra({ apiKey: "k" });
          `,
          "barrel.ts": `export * from "./instance";`,
          "app.ts": `
            import { analytics } from "./barrel";
            analytics.track("barrel_reexport");
          `,
        },
        "app.ts",
      );
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });
});
