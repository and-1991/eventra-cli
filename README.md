```{=html}
<p align="center">
```
`<img src="https://eventra.dev/eventra-icon-animated.svg" width="120" />`{=html}
```{=html}
</p>
```
# Eventra CLI

[![npm
version](https://img.shields.io/npm/v/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![npm
downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-cli.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-cli)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)

Eventra CLI automatically discovers feature usage events in your
codebase and syncs them with Eventra.

Eventra CLI helps you:

-   Discover feature usage automatically
-   Detect wrapper components
-   Keep events in sync
-   Register features in Eventra
-   Maintain consistent event naming

It is designed to be:

-   framework-agnostic
-   static analysis based
-   zero runtime overhead
-   production-safe

------------------------------------------------------------------------

# Installation

### npm

``` bash
npm install -D @eventra_dev/eventra-cli
```

### pnpm

``` bash
pnpm add -D @eventra_dev/eventra-cli
```

### yarn

``` bash
yarn add -D @eventra_dev/eventra-cli
```

### npx

``` bash
npx eventra init
```

------------------------------------------------------------------------

# Quick Start

``` bash
eventra init
eventra sync
eventra send
```

------------------------------------------------------------------------

# Commands

## eventra init

Creates `eventra.json` configuration file.

``` bash
eventra init
```

------------------------------------------------------------------------

## eventra sync

Scans your project and discovers events automatically.

``` ts
tracker.track("feature_created")
```

``` tsx
<TrackedButton event="feature_created" />
```

``` tsx
<MyComponent event="user_signup" />
```

------------------------------------------------------------------------

## eventra send

Send events to Eventra backend.

``` bash
eventra send
```

------------------------------------------------------------------------

# Supported Frameworks

-   React
-   Next.js
-   Vue
-   Nuxt
-   Svelte
-   Astro
-   Node.js
-   Express
-   NestJS

------------------------------------------------------------------------

# Requirements

-   Node.js 18+
-   JavaScript / TypeScript project

------------------------------------------------------------------------

# License

MIT
