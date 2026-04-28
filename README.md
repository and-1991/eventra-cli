<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI

[![npm version](https://img.shields.io/npm/v/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![npm downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@eventra_dev/eventra-cli)]()

Eventra CLI automatically discovers feature usage events in your codebase and syncs them with Eventra.

---

# Installation

```bash
npm install -D @eventra_dev/eventra-cli
```

```bash
pnpm add -D @eventra_dev/eventra-cli
```

---

# Quick Start

```bash
eventra init
eventra sync
eventra check
eventra send
```

---

# Commands

## eventra init

Creates `eventra.json` configuration file.

---

## eventra sync

Scans your project and discovers events automatically.

### Supports:

- track("event")
- analytics.track("event")

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

- Object format
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

- Multi-argument wrappers
```ts
trackFeature("test", "click")
```

- Cross-file tracking

- Vue / Svelte / Astro support

---

## eventra check

Validate events without modifying config.

```bash
eventra check
```

### Detects:

- New events
- Removed events
- Dynamic values

---

## eventra check --fix

Auto-fix mode.

```bash
eventra check --fix
```

---

## eventra watch

Real-time event detection.

```bash
eventra watch
```

---

## eventra send

Send events to backend.

```bash
eventra send
```

---

# Configuration

```json
{
  "apiKey": "",
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

# Supported Frameworks

- React
- Vue
- Svelte
- Astro
- Node.js
- Express
- NestJS
- Fastify

---

# Requirements

- Node.js 18+

---

# License

MIT
