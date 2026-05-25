<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI

[![npm version](https://img.shields.io/npm/v/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![npm downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@eventra_dev/eventra-cli)]()

Eventra CLI statically discovers analytics events from [**@eventra_dev/eventra-sdk**](https://www.npmjs.com/package/@eventra_dev/eventra-sdk) usage in your codebase — including function wrappers and cross-file propagation chains.

---

## Overview

The CLI scans TypeScript and JavaScript with the TypeScript compiler API and extracts **only** calls to `Eventra.prototype.track()` on instances of `Eventra` imported from `@eventra_dev/eventra-sdk`.

It does **not** detect generic `track()`, Segment, Google Analytics, or other libraries.

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

Uploads `events` from config to the Eventra API. Requires `apiKey` (and optionally `endpoint`) in `eventra.json`. Events are POSTed to `POST /api/v1/cli/events` and marked as non-billable on the backend.

---

## Configuration

```json
{
  "apiKey": "",
  "endpoint": "",
  "events": [],
  "functionWrappers": [],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".next", ".git"]
  }
}
```

---

## How it works

1. Load project files into an incremental TypeScript program (with SDK type shim).
2. **Phase 1** — find `Eventra` instances from `@eventra_dev/eventra-sdk` and register function wrappers that call `.track()`.
3. **Phase 2** — resolve static event names and wrapper propagation chains.
4. Write results to `eventra.json`.

No runtime execution. No monkey-patching.

---

## Requirements

- Node.js 18+
- TypeScript/JavaScript source using `@eventra_dev/eventra-sdk`

---

## License

MIT
