<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI

[![npm version](https://img.shields.io/npm/v/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![npm downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@eventra_dev/eventra-cli)]()

Eventra CLI automatically discovers and tracks event usage across your codebase — even through abstractions like wrappers, variables, and cross-file calls.

---

## Overview

Eventra scans your codebase using a TypeScript-powered engine and extracts event usage — even through abstractions like wrappers, variables, and cross-file calls.

It requires no runtime instrumentation and fits naturally into CI/CD workflows.

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

1. Parses your project using the TypeScript AST
2. Resolves function calls, imports, and dependencies
3. Tracks event propagation through variables and wrappers
4. Extracts event names and aggregates them

No runtime required. No SDK needed.

---

## Why Eventra

- Prevent missing or inconsistent event tracking
- Keep your analytics schema in sync with code
- Detect dead or unused events
- Integrate validation into CI pipelines

---

## Commands

### `eventra init`
Creates `eventra.json` configuration file.

---

### `eventra sync`
Scans your project and updates the list of detected events.

#### Supports

- Direct calls
```ts
track("event")
analytics.track("event")
```

- Variables
```ts
const EVENT = "click"
track(EVENT)
```

- Enums
```ts
track(EVENTS.CLICK)
```

- Template strings
```ts
track(`click_${type}`)
```

- Conditionals
```ts
track(condition ? "a" : "b")
```

- Object payloads
```ts
track({ event: "click" })
```

- Function wrappers
```ts
const trackFeature = (name: string) => {
  track(name)
}

trackFeature("click")
```

- Cross-file event resolution
- Framework templates (Vue, Svelte, Astro)

---

### `eventra check`
Validates detected events against config.

```bash
eventra check
```

Detects:
- New events
- Removed events
- Inconsistent tracking usage

---

### `eventra check --fix`
Automatically updates config to match detected events.

```bash
eventra check --fix
```

---

### `eventra watch`
Runs in watch mode and updates events in real time.

```bash
eventra watch
```

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
  "aliases": {},
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx,vue,svelte,astro}"],
    "exclude": ["node_modules", "dist", ".next", ".git"]
  }
}
```

---

## Supported Environments

Eventra works with **any JavaScript or TypeScript codebase**.

No framework limitations.

---

## Requirements

- Node.js 18+

---

## License

MIT
