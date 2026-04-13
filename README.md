<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI

[![npm version](https://img.shields.io/npm/v/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![npm downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)

Eventra CLI automatically discovers feature usage events in your codebase and syncs them with Eventra.

Eventra CLI helps you:

- Discover feature usage automatically
- Detect wrapper components
- Detect wrapper functions
- Keep events in sync
- Register features in Eventra
- Maintain consistent event naming

It is designed to be:

- framework-agnostic
- static analysis based
- zero runtime overhead
- production-safe
- backend + frontend compatible

---

# Installation

### npm

```bash
npm install -D @eventra_dev/eventra-cli
```

### pnpm

```bash
pnpm add -D @eventra_dev/eventra-cli
```

### yarn

```bash
yarn add -D @eventra_dev/eventra-cli
```

### npx

```bash
npx eventra init
```

---

# Quick Start

```bash
eventra init
eventra sync
eventra send
```

---

# Commands

## eventra init

Creates `eventra.json` configuration file.

```bash
eventra init
```

---

## eventra sync

Scans your project and discovers events automatically.

### track() detection

```ts
tracker.track("feature_created")
```

```ts
track("user_signup")
```

---

### Component wrappers

```tsx
<TrackedButton event="feature_created" />
```

```tsx
<MyComponent event="user_signup" />
```

---

### Function wrappers

```ts
trackFeature("feature_created")
```

```ts
analytics.trackFeature("user_signup")
```

---

## eventra send

Send events to Eventra backend.

```bash
eventra send
```

New events are queued for processing and will appear in dashboard shortly.

Processing typically takes:

~1-2 minutes

This delay ensures reliable event ingestion and aggregation.

---

# Configuration

Eventra CLI creates `eventra.json`

Example:

```json
{
  "apiKey": "",
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

# Supported Frameworks

Frontend:

- React
- Next.js
- Vue
- Nuxt
- Svelte
- Astro

Backend:

- Node.js
- Express
- NestJS
- Fastify
- Hono
- Bun
- Deno

---

# How It Works

Eventra CLI:

1. Scans your codebase
2. Detects tracking calls
3. Detects wrapper components
4. Detects wrapper functions
5. Syncs discovered events
6. Registers events in Eventra

No runtime SDK required.

---

# Requirements

- Node.js 18+
- JavaScript / TypeScript project

---

# License

MIT
