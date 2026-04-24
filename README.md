
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

Supports:

- track("event")
- analytics.track("event")
- function wrappers
- component wrappers
- aliases

---

## eventra check

Validate events without modifying config.

```bash
eventra check
```

### Detects:

- New events
- Unresolved dynamic events

### Output example:

```
New events:
+ user_click (src/Button.tsx:42)

Dynamic:
- eventName (src/App.tsx:10)
```

---

## eventra check --fix

Interactive auto-fix mode.

```bash
eventra check --fix
```

### What it does:

- Adds new events to config
- Resolves dynamic events via alias
- Allows skipping dynamic values

---

## eventra watch

Real-time event detection.

```bash
eventra watch
```

### Features:

- Detects new events instantly
- Debounced updates
- No duplicates
- Ignores temp files

---

## eventra send

Send events to backend.

```bash
eventra send
```

---

# Configuration

Example `eventra.json`:

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

# Key Concepts

### Aliases

```ts
const EVENT = "user_click";
track(EVENT);
```

Auto-resolved → `user_click`

---

### Dynamic events

```ts
track(eventName);
```

Must be:

- aliased
- or skipped (`__skip__`)

---

### File tracking

All events include:

```
event_name (file:line)
```

---

# Supported Frameworks

Frontend:

- React
- Vue
- Svelte
- Astro

Backend:

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
