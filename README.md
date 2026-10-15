<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/eventra-cli"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/eventra-cli.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/eventra-cli"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/eventra-cli.svg?style=flat-square&color=blue"></a>
  <a href="https://github.com/and-1991/eventra-cli/actions/workflows/test.yml"><img alt="tests" src="https://img.shields.io/github/actions/workflow/status/and-1991/eventra-cli/test.yml?branch=main&label=tests&style=flat-square&logo=vitest&logoColor=white"></a>
  <img alt="unit tests" src="https://img.shields.io/badge/unit-783%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="e2e fixtures" src="https://img.shields.io/badge/e2e-14%20fixtures-brightgreen?style=flat-square">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-100%25%20(unit)-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="node" src="https://img.shields.io/node/v/@eventra_dev/eventra-cli?style=flat-square&color=darkgreen&logo=node.js&logoColor=white">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@eventra_dev/eventra-cli?style=flat-square&color=lightgrey">
</p>

Eventra CLI statically discovers analytics events from [**@eventra_dev/eventra-sdk**](https://www.npmjs.com/package/@eventra_dev/eventra-sdk) usage in your codebase — including function wrappers and cross-file propagation chains.

---

## Overview

The CLI scans TypeScript and JavaScript with the TypeScript compiler API and extracts **only** calls to `Eventra.prototype.track()` on instances of `Eventra` imported from `@eventra_dev/eventra-sdk`.

It does **not** detect generic `track()`, Segment, Google Analytics, or other libraries out of the box - but you can opt in to a third-party library with [`sinks`](#third-party-analytics-sinks) (PostHog, Segment, Amplitude and Google Analytics 4 have built-in presets). Framework files (e.g. `.vue`, `.svelte`, `.astro`, Angular's `.html` templates) require an optional [plugin](#plugins).

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

The event name can also come from a property on the wrapper's parameter — plain access, optional chaining, element access, or destructuring (including aliased and nested):

```ts
function trackWrapper(payload: { event: string }) {
  sdk.track(payload.event);        // also: payload?.event, payload["event"]
}
trackWrapper({ event: "checkout" });

function trackDestructured({ event: name }: { event: string }) {
  sdk.track(name);
}
trackDestructured({ event: "checkout" });
```

A wrapper can call another wrapper, at any depth and across files. `trackEvent("x")` is found even when it only reaches the SDK through `capture`:

```ts
// capture.ts
export function capture(name: string, props?: object) { posthog.capture(name, props); }

// track.ts
export function trackEvent<E extends string>(event: E) { capture(event); }

// page.ts
trackEvent("checkout_started");
```

Functions handed back by a hook count too (`const analytics = useAnalytics(); analytics.capture("x")`, where the hook ends with `return { capture }`), and so does a library loaded on demand (`import("posthog-js").then(({ default: ph }) => ph.capture(name))`, `await import(...)`).

### Monorepos

Each import is resolved with the compiler options of the nearest `tsconfig.json` above the file that writes it (a config that sets no `paths` keeps the root's aliases; `node_modules` is never read for options), so an app with its own `@/*` or `~/*` aliases works without a tsconfig at the repository root. When a root `tsconfig.json` only lists `references` (the usual Vite and Vue layout), the aliases of the referenced config are used. Packages of the same repository (`workspaces` or `pnpm-workspace.yaml`) are found by their folder (`@acme/lib`, `@acme/lib/hooks/use-x`, also when the package keeps its sources in `src/`), so the scan does not need `node_modules` to link them. A real install still takes precedence.

`sync`, `check`, `watch` and `send` on a machine with room to spare (a container's memory limit counts) start themselves again with a larger memory limit (half of the machine's memory, at most 8 GB), unless you set `--max-old-space-size` yourself; `init` and `--version` never do. A new `eventra.json` written by `init` leaves out tests and coverage output (see `sync.exclude`); a config that already exists keeps scanning what it scanned.

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

## Third-party analytics (`sinks`)

Already have analytics in place? Declare it in `eventra.json` and the CLI treats its calls as event sources too, with no SDK swap. Wrappers, constants, cross-file imports and JSX component props resolve exactly as they do for the Eventra SDK.

```json
{
  "sinks": [
    { "preset": "posthog" },
    { "preset": "segment" },
    { "preset": "amplitude" },
    { "preset": "ga4" },
    { "callee": "analytics.track" },
    { "callee": "gtag", "nameArg": 1, "when": { "arg": 0, "equals": "event" } }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `preset` | A built-in rule set: `posthog`, `segment`, `amplitude` or `ga4` (see below) |
| `callee` | Dotted call path, matched as a suffix: `analytics.track` also matches `this.analytics.track`, but not `myanalytics.track` |
| `nameArg` | Zero-based index of the event-name argument (default `0`) |
| `nameProperty` | If that argument is an object literal, read the name from this property (e.g. `event`) |
| `modules` | Only match when the receiver comes from one of these npm packages (imported, re-exported, typed, or built from them) |
| `when` | Only match when the argument at `arg` is the string literal `equals`, e.g. `{ "arg": 0, "equals": "event" }` for `gtag("event", name)` |

| Preset | Detects |
|--------|---------|
| `posthog` | `posthog.capture("x")`, the `usePostHog()` hook (from `posthog-js/react` or `@posthog/react`) under any variable name (also through re-exports like `export { usePostHog as useAnalytics }`), and posthog-node's `client.capture({ distinctId, event: "x" })`, including typed class fields |
| `segment` | `analytics.track("x", props)` (analytics.js, `window.analytics`), analytics-node's `client.track({ userId, event: "x" })`, and clients from `@segment/analytics-next`, `@segment/analytics-node`, `@segment/analytics-react-native` or `analytics-node` under any variable name, including `const [analytics] = await AnalyticsBrowser.load(...)` |
| `amplitude` | `amplitude.track("x")`, `amplitude.track({ event_type: "x" })`, `amplitude.logEvent("x")`, `amplitude.getInstance().logEvent("x")`, and clients from the `@amplitude/*` browser, node, react-native and unified packages or `amplitude-js` |
| `ga4` | `gtag("event", "x", params)` (also `window.gtag` and nuxt-gtag's `const { gtag } = useGtag()`), `sendGAEvent("event", "x", params)` from `@next/third-parties`, nuxt-gtag's `useTrackEvent("x")`, vue-gtag's `this.$gtag.event("x")` and `event("x")` / `const { event } = useGtag()`, and react-ga4's `ReactGA.event("x")` / `ReactGA.event({ category, action: "x" })`. Other gtag commands (`gtag("config", id)`, `gtag("set", ...)`) are not events and are ignored |

Rules are plain data and never run code, so they are safe to commit. A rule with a typo, an invalid `when` or an unknown preset is skipped with a warning. A function with its own name (`trackEvent({ event: "x" })`) is not covered by a preset: add a rule such as `{ "callee": "trackEvent", "nameProperty": "event" }`.

The [name rules](#event-name-rules-aligned-with-sdk) below apply to these events too. Spaces and colons are allowed, so names like `App: User Sign Up` or `Order Completed` are kept as written. PostHog's `$`-prefixed names (`$pageview`, `$pageleave`) are kept as well. Names with other characters, such as one ending in `!`, are excluded from the scan result.

---

## Event name rules (aligned with SDK)

| Rule | Limit |
|------|--------|
| Max length | **64 characters** (same as SDK) |
| Allowed characters | `a-zA-Z0-9$:_./-` and the space (so `App: User Sign Up` and `$pageview` work); tabs, newlines and any other character are rejected |
| Position | First argument of `.track(name, options?)` |

The second argument (`userId`, `properties`) is **not** used as the event name.

A literal name that violates either rule (too long, or a character outside the allowed set) is not truncated and not flagged as a dynamic occurrence - it's silently excluded from the scan result, with no warning and no diagnostic anywhere. It simply never appears in `eventra.json` after `sync`. If an event you expect to see is missing, check this before assuming a detection bug.

---

## What is ignored

By default only the Eventra SDK is read. Calls to other analytics are ignored unless you enable them with [`sinks`](#third-party-analytics-sinks).

```ts
// Not from @eventra_dev/eventra-sdk (and no matching `sinks` rule)
track("legacy");
analytics.track("ga");
segment.track("x");

// Wrong API shape for SDK (object as first argument)
tracker.track({ event: "click" });
```

---

## Commands

### `eventra init`

Creates `eventra.json`. It asks for an API key and an endpoint, then looks through `package.json` (and the `package.json` of every workspace member in a monorepo: `workspaces` or `pnpm-workspace.yaml`) for analytics libraries and for the framework (`vue`, `svelte`, `astro`, `@angular/core`), and writes the matching plugin into `plugins` when it is installed. If it is not, `init` prints the install command and the line to add instead: `sync` stops on a plugin it cannot load, so `init` never writes one that would make the next `sync` fail:

```
Found analytics in package.json: posthog-js; @segment/analytics-next
? Also read events from these analytics calls (sinks):
❯◉ posthog (posthog-js)
 ◉ segment (@segment/analytics-next)
```

Everything found is pre-selected; press Enter to accept or untick what you do not want. The chosen presets are written to `sinks` in `eventra.json`. Recognised packages:

| Preset | Packages |
|--------|----------|
| `posthog` | `posthog-js`, `@posthog/react`, `posthog-js-lite`, `posthog-node`, `posthog-react-native` |
| `segment` | `@segment/analytics-next`, `@segment/analytics-node`, `@segment/analytics-react-native`, `@segment/snippet`, and the older `analytics-node`, `@segment/analytics.js-core` |
| `amplitude` | `@amplitude/analytics-browser`, `@amplitude/analytics-node`, `@amplitude/analytics-react-native`, `@amplitude/unified`, `@amplitude/marketing-analytics-browser`, and the older `amplitude-js` |
| `ga4` | `react-ga4`, `vue-gtag`, `@next/third-parties`, `nuxt-gtag`, `@types/gtag.js`, and the older `vue-gtag-next` |

Detection reads dependencies only. A tag pasted straight into the HTML (a Segment or `gtag.js` snippet with no package) is not seen: add the preset to `sinks` yourself. In a monorepo only the block-list form of `packages:` in `pnpm-workspace.yaml` is understood (not `packages: [a, b]`), and workspace patterns that are absolute or contain `..` are ignored. If `eventra.json` already exists, `init` asks before overwriting it (the default answer is no). `eventra init --yes` never prompts: it uses the default endpoint, accepts every detected preset, and leaves an existing `eventra.json` untouched, so it is safe in scripts and CI.

### `eventra sync`

Full project scan → updates `eventra.json`:

- `events` — discovered event names
- `functionWrappers` — detected wrapper functions

A file that cannot be analysed (a broken `.vue`, `.svelte`, `.astro` or `.html`, an unreadable file, or one over 2 MB) is skipped, and `sync` prints one summary at the end listing each skipped file and why. While anything is skipped, events already in `eventra.json` are kept, because a missing event may simply live in a skipped file. The exit code stays `0`; `eventra sync --strict` exits `1` if any file was skipped.

### `eventra check`

Compares config with the current scan (events + wrappers). Exit code `1` on drift. When files were skipped, known events that were not found are not reported as removed (they cannot be verified) and the skipped files are listed; `eventra check --strict` also exits `1` if any file was skipped.

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

Once `eventra.json` already commits an `endpoint`, that committed value is what events actually get sent to - `EVENTRA_ENDPOINT` only controls whether the approval prompt is skipped; its own value is not read or compared against anything in that case. `EVENTRA_ENDPOINT` becomes the real destination only when `eventra.json` has no `endpoint` set at all. In other words, setting the variable to point somewhere else does not redirect traffic away from an already-committed endpoint - it only means you won't be asked to approve it.

**Catalog snapshot.** Besides the event list, `send` scans the project once more and tells the server how trustworthy that list is, so the dashboard can compare what is in your code with what actually arrived. It adds four optional fields to the request: `complete`, `dynamicCount`, `branch` and `cliVersion`.

- `complete` is `true` only when the scan skipped no file, hit no error, and `eventra.json` matches what the scan just found. The server marks names that are missing from a complete snapshot as removed from code, so anything doubtful is `false` (a file that could not be parsed, a failed scan, or an `eventra.json` that is out of date: run `eventra sync` first). A request that is not complete never removes anything.
- `dynamicCount` is the number of event-name call sites that could not be resolved to any string (for example `track(name)` with an unknown `name`). The dashboard uses it to warn that such names may show up as unexpected events.
- `branch` is the current branch, read from the usual CI variables (`GITHUB_REF_NAME`, `CI_COMMIT_REF_NAME`, `BRANCH_NAME`, `BITBUCKET_BRANCH`, `CIRCLE_BRANCH`, `BUILDKITE_BRANCH`, `VERCEL_GIT_COMMIT_REF`) and otherwise from `git`; it is left out when unknown (for example a detached checkout with no CI variable). `cliVersion` is the CLI version.

Run `send` from the main branch in CI: a snapshot from a feature branch describes that branch. A server that predates these fields rejects them, so `send` repeats the request once with the plain event list. The extra scan adds the same time as one `eventra sync`.

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

- parses each `.vue` file with the real Vue compiler (`@vue/compiler-sfc`) into a single virtual TypeScript module combining `<script>`/`<script setup>`
- extracts `track()` calls from the script exactly like a regular `.ts` file (direct calls, wrappers, propagation)
- detects `event="feature_name"` attributes in `<template>` — both literal and dynamic (`:event="expr"`); dynamic bindings resolve through the same module scope as the script, or surface as a dynamic occurrence if unresolvable
- reads calls written anywhere in the template: `@click`/`v-on` handlers (several statements, multi-line arrows), `{{ }}` interpolations and the expressions of `v-bind`, `v-if`, `v-show`, `v-model`, `v-html`, `v-text`
- Nuxt `.vue` files (pages/layouts/components) are handled the same way; auto-imported composables resolve once the project has run `nuxt prepare`/`nuxt dev`

`sync.include` does **not** need `**/*.vue` manually — the plugin registers `**/*.vue` via `includeGlobs`. See [`@eventra_dev/cli-plugin-vue`](https://www.npmjs.com/package/@eventra_dev/cli-plugin-vue) for details.

### Svelte (`.svelte`)

```bash
pnpm add -D @eventra_dev/cli-plugin-svelte
```

```json
{
  "plugins": ["@eventra_dev/cli-plugin-svelte"]
}
```

The plugin:

- parses each `.svelte` file with the real Svelte compiler (`svelte/compiler`) into a single virtual TypeScript module combining `context="module"` and instance `<script>` blocks
- extracts `track()` calls from the script exactly like a regular `.ts` file (direct calls, wrappers, propagation); Svelte 5 runes (`$props`, `$state`, …) pass through untouched
- reads calls anywhere in the markup: handlers, `{expr}`, `{@html}`, block expressions (`{#if}`, `{#each}`, `{#key}`, `{#await}`), `use:`/`class:`/`transition:` directives and attribute values
- detects `event="feature_name"` attributes on any tag — plain elements, components, `{#if}`/`{#each}`/`{#await}`/`{#key}` blocks, slots — both literal and dynamic (`event={expr}`); dynamic bindings resolve through the same module scope as the script, or surface as a dynamic occurrence if unresolvable

`sync.include` does **not** need `**/*.svelte` manually. See [`@eventra_dev/cli-plugin-svelte`](https://www.npmjs.com/package/@eventra_dev/cli-plugin-svelte) for details.

### Astro (`.astro`)

```bash
pnpm add -D @eventra_dev/cli-plugin-astro
```

```json
{
  "plugins": ["@eventra_dev/cli-plugin-astro"]
}
```

The plugin:

- parses each `.astro` file with the real Astro compiler (`@astrojs/compiler`) into a single virtual TypeScript module from the frontmatter
- extracts `track()` calls from the frontmatter exactly like a regular `.ts` file (direct calls, wrappers, propagation); `Astro.props` and other globals pass through untouched
- reads calls in template expressions (`{track("x")}`, `attr={expr}`, `{...spread}`) and in the page's `<script>` tags, each as a module of its own (quoted `onclick="..."` strings are browser text and are not read)
- detects `event="feature_name"` attributes on any tag, including inside JSX expressions (`{cond && <Button event="..." />}`, `.map()`) — both literal and dynamic (`event={expr}`, including the `{event}` shorthand); dynamic bindings resolve through the same module scope as the frontmatter, or surface as a dynamic occurrence if unresolvable

`sync.include` does **not** need `**/*.astro` manually. See [`@eventra_dev/cli-plugin-astro`](https://www.npmjs.com/package/@eventra_dev/cli-plugin-astro) for details.

### Angular (`.html`, via `templateUrl`)

```bash
pnpm add -D @eventra_dev/cli-plugin-angular
```

```json
{
  "plugins": ["@eventra_dev/cli-plugin-angular"],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".angular", ".git"]
  }
}
```

The plugin:

- parses each component template with the real Angular compiler (`@angular/compiler`) into a virtual TypeScript module, paired with its component class (`foo.component.html` ↔ `foo.component.ts`, Angular CLI's default naming)
- extracts `track()` calls from the component class exactly like a regular `.ts` file (direct calls, wrappers, propagation) - no plugin needed for that part
- reads calls in the template: `(click)` handlers, `[input]` bindings, `{{ }}` interpolations, `*ngIf` and `@if`/`@switch`/`@for`, written against the component class (`track('x')` is `this.track('x')`); an `.html` file no component names as its `templateUrl` is skipped when it does not parse
- detects `event="feature_name"` attributes on any tag, including `*ngIf`/`*ngFor` and the `@if`/`@for`/`@switch` block syntax - both literal and dynamic; a dynamic binding resolves against the component instance (`this.field`, including getters), or surfaces as a dynamic occurrence if unresolvable
- use `[attr.event]="expr"`, not `[event]="expr"`, for a dynamic binding on a plain HTML element - `[event]` is a property binding that Angular's real compiler rejects (`NG8002`) unless the element is a component that actually declares `@Input() event`; both forms are detected identically by the plugin, only `[attr.event]` is guaranteed to compile

`sync.include` does **not** need `**/*.html` manually. Only `templateUrl`-based components are covered - an inline `template: "..."` isn't yet. Requires Node `^20.19.0 || ^22.12.0 || >=24.0.0` (higher than the other plugins' `>=18` floor - `@angular/compiler`'s own requirement). See [`@eventra_dev/cli-plugin-angular`](https://www.npmjs.com/package/@eventra_dev/cli-plugin-angular) for details.

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

No dependency on `@eventra_dev/eventra-cli` is required — the host CLI loads the plugin, converts `staticSinks` into its own internal sink detectors, and calls `transform()` on matching files; the plugin never imports anything from the CLI itself.

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
  "sinks": [],
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
| `sinks` | Third-party analytics calls to treat as event sources, e.g. `[{ "preset": "posthog" }]` (see [Third-party analytics](#third-party-analytics-sinks)) |
| `sync.include` | Base glob patterns; plugin `includeGlobs` are merged automatically |
| `sync.exclude` | Paths skipped during scan. Default for a config that has none: `node_modules`, `dist`, `.next`, `.git`. `eventra init` writes a longer list into a new `eventra.json`: that plus `coverage`, test files (`**/*.{test,spec}.{ts,tsx,js,jsx}`) and `__tests__`/`__mocks__` folders. A plain name such as `node_modules` or `dist` matches at any depth (nested `packages/*/node_modules` too); entries containing `/` or glob characters are used as written |

`eventra init`/`eventra send` never write a real key into this file — they write to `eventra.local.json` instead, which is automatically added to `.gitignore`.

---

## How it works

1. Load built-in plugins (`eventra-sdk` sink detector) and any packages listed in `plugins`.
2. Glob project files (`sync.include` + plugin `includeGlobs`).
3. Run file preprocessors (e.g. `.vue` → virtual `.ts` modules).
4. Load sources into an incremental TypeScript program (with SDK type shim).
5. **Phase 1** — find `Eventra` instances from `@eventra_dev/eventra-sdk` and register function wrappers that call `.track()`.
6. **Phase 2** - resolve static event names and wrapper propagation chains, a wrapper that calls another wrapper included (sink detector chain includes plugin sinks).
7. Write results to `eventra.json`.

`watch` tracks **disk source files** (including `.vue`), re-runs preprocessors on change, and incrementally updates the engine.

No runtime execution. No monkey-patching.

---

## Requirements

- Node.js 18+ (`eventra watch` needs Node.js 20.19+, which its file-watching dependency requires; `init`, `sync`, `check` and `send` run on 18)
- TypeScript/JavaScript source using `@eventra_dev/eventra-sdk`

---

## Test Coverage

Two test layers, **925 unit tests + 14 e2e fixtures + 3 `check` exit-code scenarios + 1 `watch` scenario**.

**100% statement/branch/function/line coverage** (v8 provider, `pnpm test:coverage`), enforced via a `coverage.thresholds` block in `vitest.config.ts` so a regression fails the build instead of silently slipping under 100%. This measures the vitest unit layer only; the e2e/`check`/`watch` fixtures run against the compiled `dist/` binary via `tsx tests/run.ts` and aren't coverage-instrumented. A handful of genuinely unreachable defensive branches (TS-internal invariants — e.g. an aliased import symbol is always fully resolved before its own declarations are ever inspected — that don't hold a second outcome in practice) are marked with `/* v8 ignore */`, with an inline comment explaining why, rather than tested.

**Unit tests (vitest)** - 47 suites covering core modules:

| Module | Covers |
|---|---|
| `ImportGraph` | Forward/reverse edges, cycles, stale-edge cleanup, file removal |
| `Scheduler` | Batch coalescing, last-write-wins per file, sequential bursts, error propagation |
| `DocumentRegistry` | Path normalization, version bumping, no-op on identical content, `ensure()` from disk |
| `CompilerContext` | Stage/update/remove files, `resolveModule` with `tsconfig.json` `paths`, source-file enumeration, nearest `tsconfig.json` per file, `references`, workspace packages without an install |
| `wrapper chains` | A wrapper calling a wrapper (depth 2 and 3), either file order, generics, destructuring, cycles, watch updates |
| `hook wrappers` | `return { capture }`, dynamic `import()` receivers, `.then` callbacks, promise-typed getters |
| `respawn` | Heap sizing (a container's lower memory limit counts), only scanning commands respawn, signals reach the child, no second respawn, explicit `--max-old-space-size` respected |
| `EventraEngine` | Direct calls, SDK isolation, cross-file wrappers, file updates, file removal, wrapper filtering |
| `PluginRegistry` | Built-in SDK sink, preprocessors, virtual-path mapping, include-pattern dedup |
| `external plugin adapter` | Transform output mapping, static sink registration, invalid result rejection |
| `external plugin dynamic sink` | A non-literal argument at a plugin-declared static sink surfaces as a dynamic occurrence instead of being silently dropped |
| `vue-shaped`/`svelte-shaped`/`astro-shaped` external plugin | Adapter path for script + template virtual modules and `staticSinks`, one suite per framework |
| `processFile` | Script-kind detection, import/export specifier extraction |
| `extractTemplateExpressions` | Vue/Svelte/Astro attribute patterns |
| `config` | `normalizeConfig` (sort events, dedupe wrappers, defaults, preserve `apiKey`/`endpoint`/`sync`/`plugins`); `resolveApiKey` env-var > `eventra.local.json` > legacy-inline priority, `saveLocalApiKey`'s gitignore-append |
| `scanResults` (`buildConfigFromScan`) | Replace events + wrappers, preserve everything else |
| `hash` | Stability and uniqueness |
| `cross-file SDK detection` | Direct `.track()` and wrapper calls resolve across files even when the call-site file never imports the SDK package itself |
| `dynamic event reporter` | Dynamic vs. static call classification, end-to-end `registerDynamicEventReporter` invocation |
| `load plugins` | Trusted-specifier allowlist (`^@eventra_dev/cli-plugin-[a-z0-9-]+$`), accepted/rejected plugin shapes |
| `Nuxt auto-import compatibility` | Ambient `declare const x: typeof import(...)` shape resolution - a hand-written fixture; a real `nuxt prepare` project was also verified manually, but that check is not automated |
| `property propagation` | Direct/optional/nested property access, destructured/aliased/nested-destructured params, element access, enum member access (same-file and cross-file), wrapper detection surviving a cast/non-null assertion, and direct object-literal payloads to `track()` staying ignored (including when cast) |
| `send()` | Endpoint trust-on-first-use (TOFU): default-trusted, blocked-until-approved, approve-then-persists, re-block-on-change, env-var-bypasses-approval |
| `wrapper detector plugin` | A custom `WrapperDetector` (e.g. a template-literal wrapper shape the built-in analyzer can't cover) alongside the built-in fallback |
| `configured sinks` | `sinks` rules and the PostHog, Segment, Amplitude and GA4 presets: every call shape, receivers traced through imports, re-exports, hooks, typed fields and aliases, the `when` guard, spaced names, wrong-typed config, circular chains |
| `sink presets` | The package table behind the presets: detection per package, order, legacy and detect-only flags, rules vetted only against their own preset's packages |
| `project dependencies` | package.json and workspace reading for `eventra init` (`workspaces`, pnpm-workspace.yaml, negations, caps, patterns that leave the project, unreadable files) |
| `init` | `eventra init` prompts, pre-selected presets, written config, exact console output, API key kept out of `eventra.json` |
| `preset package check` | The registry verdicts behind `pnpm check:presets` (missing, deprecated, stale, legacy) |
| `license` | `LICENSE` is the complete MIT text, its holder is the package author, and both match `package.json` |

**End-to-end fixtures** - 14 isolated TS projects scanned via `eventra sync`:

| Fixture | Covers |
|---|---|
| `sdk/direct` | Plain `tracker.track()` calls |
| `frontend/react`, `frontend/next`, `frontend/vue` | Framework-specific code shapes |
| `backend/node`, `backend/express`, `backend/nest` | Backend wrappers and middleware chains |
| `wrappers/function` | Local wrapper functions, methods, objects, ternaries, templates |
| `wrappers/barrel` | `export * from "./tracker"` re-exports |
| `wrappers/default-export` | `export default function trackFeature` propagation |
| `wrappers/path-aliases` | `tsconfig.json` `paths` mapping (`@app/*`) |
| `sinks/presets` | PostHog, Segment, Amplitude and GA4 side by side, including `gtag("config")` that must not count |
| `sinks/spaced-names` | Names with spaces and colons through the SDK, PostHog (client and server shapes), a custom rule, wrappers and JSX, plus calls that must be ignored |
| `watch-incremental` | Engine state across sequential file updates (matches `sync` output) |

**`eventra check` exit-code scenarios:**

- Drift → exit `1`
- `--fix` writes scan results into `eventra.json` → exit `0`
- Parity (no drift) → exit `0`

**`eventra watch` scenario:** a real `watch` process detects a brand-new file (created after startup) and its `.track()` call lands in `eventra.json`.

Run locally:

```bash
pnpm --filter @eventra_dev/eventra-cli test       # unit + e2e + exit codes
pnpm --filter @eventra_dev/eventra-cli test:unit  # vitest only
pnpm --filter @eventra_dev/eventra-cli test:e2e   # fixtures + check exit codes
```

> **Node version note:** the CLI itself supports Node 18+ (see `engines`), but `vitest@4` depends on `node:util`'s `styleText`, which requires Node **≥ 20.12** — running the test suite on an older Node 20.x patch (or Node 18) fails to start. CI runs the matrix on Node 20 and 22; locally, use the version pinned in the repo's `.nvmrc`.

---

## License

MIT, copyright (c) 2026 [and-1991](https://github.com/and-1991). See [LICENSE](LICENSE).
