<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/eventra-cli"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/eventra-cli.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/eventra-cli"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/eventra-cli.svg?style=flat-square&color=blue"></a>
  <a href="https://github.com/and-1991/eventra-cli/actions/workflows/test.yml"><img alt="tests" src="https://img.shields.io/github/actions/workflow/status/and-1991/eventra-cli/test.yml?branch=main&label=tests&style=flat-square&logo=vitest&logoColor=white"></a>
  <img alt="unit tests" src="https://img.shields.io/badge/unit-74%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="e2e fixtures" src="https://img.shields.io/badge/e2e-12%20fixtures-brightgreen?style=flat-square">
  <img alt="node" src="https://img.shields.io/node/v/@eventra_dev/eventra-cli?style=flat-square&color=darkgreen&logo=node.js&logoColor=white">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@eventra_dev/eventra-cli?style=flat-square&color=lightgrey">
</p>

Eventra CLI statically discovers analytics events from [**@eventra_dev/eventra-sdk**](https://www.npmjs.com/package/@eventra_dev/eventra-sdk) usage in your codebase — including function wrappers and cross-file propagation chains.

---

## Overview

The CLI scans TypeScript and JavaScript with the TypeScript compiler API and extracts **only** calls to `Eventra.prototype.track()` on instances of `Eventra` imported from `@eventra_dev/eventra-sdk`.

It does **not** detect generic `track()`, Segment, Google Analytics, or other libraries out of the box. Framework files (e.g. `.vue`) require an optional [plugin](#plugins).

---

## Installation

```bash
npm install -D @eventra_dev/eventra-cli
# or
pnpm add -D @eventra_dev/eventra-cli
```

Your project should use the runtime SDK:

```bash
pnpm add @eventra_dev/eventra-sdk
```

---

## Quick Start

```bash
eventra init
eventra sync
eventra check
eventra send
```

---

## What gets detected

### Direct SDK calls

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "YOUR_PROJECT_API_KEY" });

tracker.track("checkout.completed");
tracker.track("app.loaded", { userId: "user_123" });
tracker?.track("optional.chain");
```

### Function wrappers (propagation)

Wrappers that call `Eventra.track()` inside are registered automatically:

```ts
function trackFeature(name: string) {
  sdk.track(name);
}

trackFeature("purchase");
```

### Variables, templates, conditionals

```ts
const EVENT = "signup";
tracker.track(EVENT);

tracker.track(`feature_${type}`);

tracker.track(flag ? "path.a" : "path.b");
```

### Cross-file

```ts
// tracker.ts
export function trackFeature(name: string) {
  client.track(name);
}

// app.ts
import { trackFeature } from "./tracker";
trackFeature("purchase");
```

---

## Event name rules (aligned with SDK)

| Rule | Limit |
|------|--------|
| Max length | **64 characters** (same as SDK) |
| Allowed characters | `a-zA-Z0-9:_./-` |
| Position | First argument of `.track(name, options?)` |

The second argument (`userId`, `properties`) is **not** used as the event name.

---

## What is ignored

```ts
// Not from @eventra_dev/eventra-sdk
track("legacy");
analytics.track("ga");
segment.track("x");

// Wrong API shape for SDK (object as first argument)
tracker.track({ event: "click" });
```

---

## Commands

### `eventra sync`

Full project scan → updates `eventra.json`:

- `events` — discovered event names
- `functionWrappers` — detected wrapper functions

### `eventra check`

Compares config with the current scan (events + wrappers). Exit code `1` on drift.

### `eventra check --fix`

Writes scan results into `eventra.json`.

### `eventra watch`

Incremental scan with the same rules as `sync`.

### `eventra send`

Uploads `events` from config to the Eventra API. Requires an API key and (optionally) an `endpoint`. Events are POSTed to `POST /api/v1/cli/events` and marked as non-billable on the backend.

**API key resolution** (checked in this order, never written to `eventra.json`):

1. `EVENTRA_API_KEY` environment variable — recommended for CI
2. `eventra.local.json` (created by `eventra init`/`eventra send`, automatically gitignored)
3. legacy inline `apiKey` in `eventra.json` (deprecated — avoid committing real keys here)

`eventra.json` is meant to be committed so CI can diff it via `eventra check`; keeping the key out of it avoids leaking it into source control. In a non-interactive shell (no TTY), `send` fails fast with a message pointing at `EVENTRA_API_KEY` instead of hanging on a prompt.

**Endpoint trust.** The default production endpoint is always used with no extra step. A *custom* `endpoint` is only trusted without approval when it comes from the `EVENTRA_ENDPOINT` environment variable (setting an env var is already a local/CI action). A custom `endpoint` committed inline in `eventra.json` is trust-on-first-use: `send` refuses to run until it's approved once with:

```bash
eventra send --trust-endpoint
```

This records the endpoint in `eventra.local.json` (gitignored). If `eventra.json`'s `endpoint` later changes to a different value — e.g. a PR silently pointing it at another host — `send` blocks again until re-approved, so a committed config change alone can't redirect where your API key and events get sent.

Network resilience:

- Up to 4 attempts with exponential backoff + jitter (capped at 8 s)
- Retries on 429 and 5xx responses, and on transport errors (timeout / DNS / connection reset)
- Permanent failure (4xx other than 429) surfaces immediately without retry
- 10 s timeout per attempt via `AbortController`

---

## Plugins

The CLI core is framework-agnostic. Extensions are **separate npm packages** with their own types — the CLI loads them from `eventra.json` and adapts their output internally.

### Vue (`.vue` SFC)

Install the official Vue plugin and enable it in config:

```bash
pnpm add -D @eventra_dev/cli-plugin-vue
```

```json
{
  "plugins": ["@eventra_dev/cli-plugin-vue"],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".next", ".git"]
  }
}
```

The plugin:

- splits each `.vue` file into virtual TypeScript modules (`App.vue.ts`, `App.vue.template.ts`)
- extracts `track()` calls from `<script>` blocks
- detects static `event="feature_name"` attributes in `<template>` (literals only)

`sync.include` does **not** need `**/*.vue` manually — the plugin registers `**/*.vue` via `includeGlobs`.

### Before publishing / local development

Plugins are resolved from your project's `node_modules` (same as any dependency):

```json
{
  "devDependencies": {
    "@eventra_dev/cli-plugin-vue": "file:../cli-plugin-vue"
  }
}
```

The plugin package must be built (`dist/`) before use. Unpublished plugins work the same way — only the install source differs.

### Plugin contract (for authors)

External plugins export an object (or factory) with:

| Field | Purpose |
|-------|---------|
| `id` | Unique preprocessor name |
| `includeGlobs` | Extra glob patterns merged into the scan |
| `match(path)` | Whether this plugin handles a file |
| `transform({ path, source })` | Returns `{ modules: [{ path, content }] }` |
| `staticSinks?` | Declarative callee-based sink rules (CLI converts to internal detectors) |

No dependency on `@eventra_dev/eventra-cli` is required. See [`ARCHITECTURE.md`](./ARCHITECTURE.md#plugin-kernel-phase-15--foundation-shipped) for details.

**Only official `@eventra_dev/cli-plugin-*` packages can be loaded.** `eventra.json` is meant to be committed to git, so its `plugins` array is effectively PR-editable; since the CLI `import()`s whatever is listed there, an arbitrary specifier would be arbitrary code execution on every machine that runs `sync`/`check`/`watch`. Because `@eventra_dev` is an npm scope only the Eventra maintainers can publish to, restricting to `@eventra_dev/cli-plugin-*` means nothing outside that scope can ever be loaded this way. Any other entry in `plugins` is skipped with a console warning instead of being imported — third-party/community plugins aren't supported today.

---

## Configuration

```json
{
  "apiKey": "",
  "endpoint": "",
  "events": [],
  "functionWrappers": [],
  "plugins": [],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".next", ".git"]
  }
}
```

| Field | Description |
|-------|-------------|
| `apiKey` | Legacy inline API key — leave empty. Use `EVENTRA_API_KEY` or `eventra.local.json` instead (see [`eventra send`](#eventra-send)) so a real key never ends up in this committed file |
| `endpoint` | Custom `eventra send` target (e.g. self-hosted). Non-default values from this file need one-time local approval — see [`eventra send`](#eventra-send) |
| `plugins` | `@eventra_dev/cli-plugin-*` specifiers to `import()` at startup. Anything outside that scope is skipped (see [Plugin contract](#plugin-contract-for-authors)) |
| `sync.include` | Base glob patterns; plugin `includeGlobs` are merged automatically |
| `sync.exclude` | Paths skipped during scan |

`eventra init`/`eventra send` never write a real key into this file — they write to `eventra.local.json` instead, which is automatically added to `.gitignore`.

---

## How it works

1. Load built-in plugins (`eventra-sdk` sink detector) and any packages listed in `plugins`.
2. Glob project files (`sync.include` + plugin `includeGlobs`).
3. Run file preprocessors (e.g. `.vue` → virtual `.ts` modules).
4. Load sources into an incremental TypeScript program (with SDK type shim).
5. **Phase 1** — find `Eventra` instances from `@eventra_dev/eventra-sdk` and register function wrappers that call `.track()`.
6. **Phase 2** — resolve static event names and wrapper propagation chains (sink detector chain includes plugin sinks).
7. Write results to `eventra.json`.

`watch` tracks **disk source files** (including `.vue`), re-runs preprocessors on change, and incrementally updates the engine.

No runtime execution. No monkey-patching.

---

## Requirements

- Node.js 18+
- TypeScript/JavaScript source using `@eventra_dev/eventra-sdk`

---

## Test Coverage

Two test layers, **74 unit tests + 12 e2e fixtures + 3 `check` exit-code scenarios**.

**Unit tests (vitest)** — 13 suites covering core modules:

| Module | Covers |
|---|---|
| `ImportGraph` | Forward/reverse edges, cycles, stale-edge cleanup, file removal |
| `Scheduler` | Batch coalescing, last-write-wins per file, sequential bursts, error propagation |
| `DocumentRegistry` | Path normalization, version bumping, no-op on identical content, `ensure()` from disk |
| `CompilerContext` | Stage/update/remove files, `resolveModule` with `tsconfig.json` `paths`, source-file enumeration |
| `EventraEngine` | Direct calls, SDK isolation, cross-file wrappers, file updates, file removal, wrapper filtering |
| `PluginRegistry` | Built-in SDK sink, preprocessors, virtual-path mapping, include-pattern dedup |
| `external plugin adapter` | Transform output mapping, static sink registration, invalid result rejection |
| `vue-shaped external plugin` | Adapter path for script + template virtual modules and `staticSinks` |
| `processFile` | Script-kind detection, import/export specifier extraction |
| `extractTemplateExpressions` | Vue/Svelte/Astro attribute patterns |
| `normalizeConfig` | Sort events, dedupe wrappers, defaults, preserve `apiKey` / `endpoint` / `sync` / `plugins` |
| `buildConfigFromScan` | Replace events + wrappers, preserve everything else |
| `hash` | Stability and uniqueness |

**End-to-end fixtures** — 12 isolated TS projects scanned via `eventra sync`:

| Fixture | Covers |
|---|---|
| `sdk/direct` | Plain `tracker.track()` calls |
| `frontend/react`, `frontend/next`, `frontend/vue` | Framework-specific code shapes |
| `backend/node`, `backend/express`, `backend/nest` | Backend wrappers and middleware chains |
| `wrappers/function` | Local wrapper functions, methods, objects, ternaries, templates |
| `wrappers/barrel` | `export * from "./tracker"` re-exports |
| `wrappers/default-export` | `export default function trackFeature` propagation |
| `wrappers/path-aliases` | `tsconfig.json` `paths` mapping (`@app/*`) |
| `watch-incremental` | Engine state across sequential file updates (matches `sync` output) |

**`eventra check` exit-code scenarios:**

- Drift → exit `1`
- `--fix` writes scan results into `eventra.json` → exit `0`
- Parity (no drift) → exit `0`

Run locally:

```bash
pnpm --filter @eventra_dev/eventra-cli test       # unit + e2e + exit codes
pnpm --filter @eventra_dev/eventra-cli test:unit  # vitest only
pnpm --filter @eventra_dev/eventra-cli test:e2e   # fixtures + check exit codes
```

> **Node version note:** the CLI itself supports Node 18+ (see `engines`), but `vitest@4` depends on `node:util`'s `styleText`, which requires Node **≥ 20.12** — running the test suite on an older Node 20.x patch (or Node 18) fails to start. CI runs the matrix on Node 20 and 22; locally, use the version pinned in the repo's `.nvmrc`.

---

## License

MIT
