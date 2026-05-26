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
Source Files
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
- Framework template analysis (Vue SFC, Svelte) — outside the core, planned as plugins

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

## Plugin-oriented design (planned)

The core engine intentionally does not contain:

- React-specific logic
- Vue-specific logic
- Svelte-specific logic
- analytics-SDK-specific logic beyond `@eventra_dev/eventra-sdk`

Framework / SDK support is planned via a plugin kernel:

| Layer | Responsibility |
|-------|----------------|
| Core | AST traversal, semantic resolution, propagation analysis, incremental compilation, cache invalidation, symbol normalization |
| Plugin | Sink detection, framework adapters, SDK integrations, custom propagation rules, template extraction |

Planned plugin API sketch:

```ts
export interface EventraPlugin {
  name: string;
  setup(api: EventraPluginAPI): void;
}
```

---

## Output

The engine writes results into `eventra.json` at the project root:

```json
{
  "apiKey": "",
  "endpoint": "",
  "events": ["checkout.completed", "..."],
  "functionWrappers": ["trackFeature"],
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
Phase 1.5 Plugin kernel foundation
   ↓
Phase 2   Framework + SDK plugin ecosystem
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
- Framework-agnostic core, plugin-ready evolution path

---

## Related docs
- [README.md](./README.md) — usage and commands
