<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI

[![npm version](https://img.shields.io/npm/v/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![npm downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@eventra_dev/eventra-cli)]()

Eventra CLI automatically discovers and tracks event usage across your codebase — even through abstractions like wrappers, propagation chains, variables, and cross-file calls.

---

## Overview

Eventra scans your JavaScript and TypeScript codebase using a TypeScript-powered semantic engine and extracts analytics event usage statically.

It supports semantic parameter propagation, return propagation, cross-file resolution, and incremental dependency-aware analysis.

No runtime instrumentation required.

---

## Installation

```bash
npm install -D @eventra_dev/eventra-cli
# or
pnpm add -D @eventra_dev/eventra-cli
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

## How it works

1. Parses your project using the TypeScript compiler API
2. Builds semantic indexes from AST nodes
3. Resolves wrappers, imports, exports, and propagation chains
4. Extracts concrete analytics events statically
5. Incrementally re-analyzes only affected files

No runtime SDK hooks.
No Babel transforms.
No instrumentation.

---

## Why Eventra

* Prevent missing or inconsistent event tracking
* Keep analytics schemas synchronized with source code
* Detect dead or unused events
* Analyze wrapper-heavy codebases statically
* Integrate validation into CI/CD pipelines
* Avoid runtime analytics overhead

---

## Commands

### `eventra init`

Creates `eventra.json` configuration file.

---

### `eventra sync`

Scans your project and updates the list of detected events.

#### Supports

##### Direct calls

```ts
track("event")
analytics.track("event")
```

##### Variables

```ts
const EVENT = "click"
track(EVENT)
```

##### Enums

```ts
track(EVENTS.CLICK)
```

##### Template strings

```ts
track(`click_${type}`)
```

##### Conditional expressions

```ts
track(condition ? "a" : "b")
```

##### Arrays

```ts
track(["a", "b"])
```

##### Object payloads

```ts
track({
  event: "click"
})
```

##### Function wrappers

```ts
function trackFeature(name: string) {
  track(name)
}

trackFeature("click")
```

##### Semantic parameter propagation

```ts
function trackEvent(props: {
  event: string
}) {
  track(props.event)
}

trackEvent({
  event: "purchase"
})
```

##### Return propagation

```ts
function buildEvent(name: string) {
  return name
}

track(buildEvent("signup"))
```

##### Cross-file resolution

```ts
import { trackFeature } from "./tracker"

trackFeature("purchase")
```

---

### `eventra check`

Validates detected events against config.

```bash
eventra check
```

Detects:

* New events
* Removed events
* Invalid or inconsistent tracking usage

---

### `eventra check --fix`

Automatically updates config to match detected events.

```bash
eventra check --fix
```

---

### `eventra watch`

Runs in watch mode with incremental semantic analysis.

```bash
eventra watch
```

Only affected files are re-analyzed after changes.

---

### `eventra send`

Sends events to Eventra backend.

```bash
eventra send
```

---

## Configuration

```json
{
  "apiKey": "",
  "endpoint": "",
  "events": [],
  "wrappers": [],
  "functionWrappers": [],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": [
      "node_modules",
      "dist",
      ".next",
      ".git"
    ]
  }
}
```

---

## Architecture Highlights

### Semantic propagation analysis

Eventra resolves event propagation through wrappers and returned values.

```ts
function createEvent(name: string) {
  return name
}

function trackEvent(name: string) {
  track(createEvent(name))
}
```

---

### Incremental analysis engine

Eventra does NOT rescan the whole project after every update.

Instead it:

1. Updates changed files
2. Invalidates affected caches
3. Rebuilds TypeScript incrementally
4. Traverses dependency graph
5. Re-analyzes affected files only

---

### Static extraction

Eventra works entirely statically.

No runtime execution.
No monkey patching.
No SDK instrumentation.

---

## Supported Environments

Eventra works with:

* JavaScript
* TypeScript
* Node.js projects
* Browser applications
* Monorepos

---

## Requirements

* Node.js 18+

---

## License

MIT
