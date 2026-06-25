# Eventra CLI — Engine Architecture

This document describes the **static analysis engine** that powers `@eventra_dev/eventra-cli`. For backend / ingest / billing architecture see [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).

## What this engine is

```
Incremental Semantic TypeScript Analysis Engine
```

It is **not**:

- a regex scanner
- a runtime instrumentation SDK
- a generic analytics-call extractor (it only resolves calls on `Eventra` instances imported from `@eventra_dev/eventra-sdk`)

The CLI runs the TypeScript compiler API over the project, resolves symbols semantically, and extracts only the calls that statically map to `Eventra.prototype.track()`.

---

## High-level pipeline

```text
Source Files (disk)
     |
     v
Plugin preprocessors          (.vue → virtual .ts, …)
     |
     v
TypeScript Compiler API   (incremental program)
     |
     v
Incremental Compiler Context
     |
     v
Semantic Scanner
     |
     +-----------------------------+
     |                             |
     v                             v
Sink Detection              Wrapper Analysis
     |                             |
     +-------------+---------------+
                   |
                   v
         Semantic Propagation
                   |
                   v
         Static Value Resolver
                   |
                   v
            Event Extraction
                   |
                   v
             Final Event Set
                   |
                   v
            Write to eventra.json
```

---

## Resolution flow

```text
CallExpression
      |
      v
resolveFunctionFromCall()
      |
      +-------------------+
      |                   |
      v                   v
Alias Resolution   Export Resolution
      |                   |
      +---------+---------+
                |
                v
Resolved Function
                |
                v
WrapperRegistry
                |
                v
Propagation Metadata
                |
                v
resolveNodeValue()
                |
                v
Final Static Values
```

---

## Static resolution coverage

### Supported

Direct tracking:

```ts
track("signup")
analytics.track("purchase")
sdk?.track("checkout")
sdk["track"]("login")
```

Variables, enums, templates, concatenation, conditionals, arrays:

```ts
const EVENT = "signup"
track(EVENT)

enum EVENTS { LOGIN = "login" }
track(EVENTS.LOGIN)

track(`feature_${type}`)
track("feature_" + type)
track(flag ? "a" : "b")
track(["a", "b"])
```

Object / shorthand payloads:

```ts
track({ event: "signup" })
track({ event })
```

Wrapper functions and cross-file wrappers:

```ts
function trackFeature(event: string) {
  track(event)
}

// other file
import { trackFeature } from "./tracker"
trackFeature("purchase")
```

Multi-arg wrappers, return propagation, property propagation, destructuring (incl. aliased and nested):

```ts
function wrapper(a: unknown, b: unknown, event: string) { track(event) }

function build(name: string) { return name }
track(build("signup"))

track(payload.event)
track(payload?.event)
track(payload["event"])

function w1({ event }: { event: string }) { track(event) }
function w2({ event: name }: { event: string }) { track(name) }
function w3({ meta: { event } }: { meta: { event: string } }) { track(event) }
```

### Intentional non-goals (today)

- Runtime execution (`fetch`, `localStorage`, `process.env`)
- Dynamic evaluation (`eval`)
- Full control-flow graph
- Deep recursive interprocedural traversal
- Mutation tracking (`payload.event = "x"`)
- Full object graph evaluation
- Async semantic propagation (`await`, `Promise.then`)
- Framework template analysis in the core (Vue SFC via `@eventra_dev/cli-plugin-vue`; Svelte still planned)

---

## Incremental engine

### CompilerContext
Maintains an incremental TypeScript program and reuses it across `sync` / `watch` runs.

### Scheduler
Coordinates async file updates and incremental rebuilds.

### ImportGraph
Tracks dependencies between files and provides:

- dependent collection
- selective invalidation
- incremental rescans

### FileSemanticIndex
Per-file storage of:

- sinks
- wrappers
- track calls
- semantic metadata

---

## Cache architecture

| Cache | What it stores |
|-------|----------------|
| `EvaluationCache` | Resolved identifier values |
| `ResolvedCallCache` | Resolved call targets |
| `ResolvedExportCache` | Normalized exported symbols |
| `ReturnPropagationCache` | Return propagation analysis |

### Cache invalidation

```text
Changed File
      |
      v
Dependency Graph
      |
      v
Affected Dependents
      |
      v
Selective Cache Invalidation
      |
      v
Incremental Re-analysis
```

Only the affected slice is invalidated — unrelated files keep their cached analysis.

---

## Wrapper propagation system

### WrapperRegistry

Stores propagation metadata for wrappers. Supports:

- local wrappers
- imported wrappers
- normalized exports
- parameter propagation
- property propagation

### Propagation metadata shape

```ts
{
  sourceParameter,
  sourceParameterIndex,
  propertyPath,
  targetNode,
}
```

---

## Resolver capabilities

Current resolver supports:

- identifier resolution
- export normalization
- enum resolution
- object literal resolution
- property access resolution
- wrapper-aware resolution
- return propagation
- static string evaluation
- partial interprocedural propagation

---

## Plugin kernel (Phase 1.5 — foundation shipped)

Built-in SDK detection is implemented as the first plugin (`eventra-sdk`). The core engine stays framework-agnostic; extensions are separate packages loaded at startup.

| Layer | Responsibility |
|-------|----------------|
| **Core** | TS program, propagation, resolver, incremental graph, cache invalidation |
| **Plugin adapter** | Duck-type external contract → internal `FilePreprocessor` / `SinkDetector` |
| **External plugin** | Own types, no dependency on `@eventra_dev/eventra-cli` |

### External plugin contract

Plugins are separate packages. The CLI validates and adapts them in `src/plugin/adapters/external.ts`.

```ts
// Contract defined by the plugin package (example: @eventra_dev/cli-plugin-vue)
export interface CliPluginVue {
  readonly id: string;
  readonly version: string;
  readonly includeGlobs: readonly string[];
  readonly staticSinks?: readonly CliPluginStaticCalleeSink[];
  match(path: string): boolean;
  transform(input: { path: string; source: string }): Promise<{
    modules: Array<{ path: string; content: string }>;
  }>;
}

export interface CliPluginStaticCalleeSink {
  readonly id: string;
  readonly callee: string;              // CallExpression callee identifier
  readonly eventNameArgumentIndex: number;
}
```

CLI internal mapping:

| Plugin returns | CLI uses |
|----------------|----------|
| `modules[].path` | `VirtualFile.fileName` |
| `modules[].content` | `VirtualFile.content` |
| `includeGlobs` | merged into `sync.include` for the run |
| `staticSinks` | `SinkDetector` (string-literal arg at index) |

### Loading

```json
{
  "plugins": ["@eventra_dev/cli-plugin-vue"]
}
```

- Built-ins load first (`eventra-sdk` sink detector).
- Each entry in `plugins` is dynamically `import()`-ed from the **user project's** `node_modules`.
- Export must be a plugin object or a factory (`default`, or `createCliPluginVue()` — sync or async).
- `createPluginRegistry(config)` runs at the start of `sync` / `watch`.
- Empty specifiers are skipped. Load failures throw with a clear message (including a hint when `@eventra_dev/plugin-vue` is used instead of `cli-plugin-vue`).

Unpublished plugins work via `file:`, `link:`, or git URL in `package.json` — the plugin must be installed and built (`dist/`) in the consumer project.

### Hook execution order

```text
disk file
  → FilePreprocessor (first matching plugin; empty result → next / passthrough)
  → TypeScript program + WrapperRegistry + propagation (core)
  → SinkDetector chain (built-in eventra-sdk, then plugin staticSinks)
  → event names
```

### Watch mode

`watch` observes **disk source paths** from the glob (e.g. `App.vue`), not virtual modules (`App.vue.ts`). On change:

1. Re-run `preprocessFile` for the source file
2. Push updated virtual content into `EventraEngine`
3. On `unlink`, remove all virtual paths recorded for that source (`PluginRegistry.getVirtualPathsForSource`)

### Planned hooks (not implemented yet)

- `registerDynamicEventReporter` — surface unresolved `dynamic: true` names in CLI output
- `registerWrapperDetector` — custom wrapper propagation rules
- Plugin config block in `eventra.json` per plugin id

---

## Output

The engine writes results into `eventra.json` at the project root:

```json
{
  "apiKey": "",
  "endpoint": "",
  "events": ["checkout.completed", "..."],
  "functionWrappers": ["trackFeature"],
  "plugins": ["@eventra_dev/cli-plugin-vue"],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".next", ".git"]
  }
}
```

`eventra check` compares the current scan against this config; `eventra sync` rewrites it.
`eventra send` uploads `events` to the Eventra API using `apiKey` from this config.

---

## Failure model

Safe to handle:

- process crash mid-scan (incremental rebuild on next run)
- partial cache state (selective invalidation replays)
- duplicate scans over the same set
- transient file system errors

---

## Roadmap

```text
Phase 0   Regex / AST scanning              (done — legacy baseline)
   ↓
Phase 1   Semantic propagation engine       (current)
   ↓
Phase 1.5 Plugin kernel foundation          (shipped — registry, adapter, watch)
   ↓
Phase 2   More framework plugins (Svelte) + dynamic event reporting
          Vue shipped as @eventra_dev/cli-plugin-vue (separate package)
   ↓
Phase 3   Semantic provenance graph
   ↓
Phase 4   Advanced interprocedural analysis
```

---

## Design philosophy

```text
Semantic analysis over regex matching.
Framework-agnostic core.
Incremental everything.
Plugins over hardcoded integrations.
Near-zero runtime overhead.
```

---

## Current strengths

- Incremental TypeScript compiler reuse
- Semantic propagation engine
- Wrapper-aware extraction (incl. cross-file)
- TypeChecker-powered symbol resolution
- Static value evaluation (strings, enums, templates, conditionals, property paths)
- Dependency-aware cache invalidation
- Plugin kernel with external-package contract (`cli-plugin-vue` for Vue SFC)

---

## Related docs
- [README.md](./README.md) — usage and commands
