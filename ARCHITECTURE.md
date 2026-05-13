# Eventra CLI Architecture

## High-Level Flow

FILES → CompilerContext → scanSource → extractEvents → EventraEngine → CLI

---

## Diagram

```
                +-------------------+
                |   Source Files    |
                | ts/js             |
                +---------+---------+
                          |
                          v
                +-------------------+
                |   ProcessedFile   |
                | normalized TS AST |
                +---------+---------+
                          |
                          v
                +-------------------+
                | CompilerContext   |
                | TS Program/Types  |
                +---------+---------+
                          |
                          v
                +-------------------+
                |    scanSource     |
                | semantic indexing |
                +----+------+-------+
                     |      |
                     |      |
                     v      v
          +----------------+----------------+
          |                                 |
+-------------------+            +-----------------------+
| Function Wrappers |            | Return Propagation    |
+-------------------+            +-----------------------+
          |                                 |
          +---------------+-----------------+
                          |
                          v
                +-------------------+
                |  extractEvents    |
                | resolveNodeValue  |
                +---------+---------+
                          |
                          v
                +-------------------+
                |  EventraEngine    |
                | caching + graph   |
                +---------+---------+
                          |
                          v
                +-------------------+
                | CLI Commands      |
                | sync/check/watch  |
                +-------------------+
```

---

# Core Architecture

## 1. Processing Layer

Normalizes JS/TS source files into TypeScript AST-compatible sources.

### Supported

* TypeScript
* JavaScript

### Components

* `processFile.ts`

### Output

```ts
interface ProcessedFile {
  fileName: string;
  scriptKind: ts.ScriptKind;
  content: string;
  dependencies: string[];
}
```

---

# 2. Compiler Layer

Provides incremental TypeScript infrastructure.

## Responsibilities

* Source file management
* Incremental program rebuilds
* Module resolution
* Type checker access
* Dependency graph updates
* Incremental invalidation

## Components

### `compilerContext.ts`

Main TypeScript orchestration layer.

### `documentRegistry.ts`

Stores snapshots and versions.

### `importGraph.ts`

Tracks file dependency graph.

### `scheduler.ts`

Batched async updates.

---

# 3. Engine Layer

Performs semantic analysis and extraction.

---

## `scanSource`

Builds semantic index from AST.

### Detects

* `track(...)`
* `tracker.track(...)`
* wrapper functions
* propagation wrappers
* imported wrappers
* return propagation

### Produces

```ts
interface FileSemanticIndex {
  sinks: TrackSink[];
  trackCalls: TrackCall[];
  wrappers: WrapperSemanticInfo[];
}
```

---

## `extractEvents`

Extracts concrete event names from semantic index.

Uses:

* `resolveNodeValue`
* caches
* export resolution
* propagation analysis
* symbol analysis

---

## `resolveNodeValue`

Static evaluator capable of resolving:

### Supported

```ts
track("click")

const EVENT = "click"
track(EVENT)

track(`click_${type}`)

track(condition ? "a" : "b")

track(["a", "b"])

track({
  event: "click"
})

track(EVENTS.CLICK)

track(buildEvent("signup"))
```

---

# Wrapper Propagation

Eventra performs semantic propagation analysis instead of simple wrapper detection.

```ts
function trackFeature(name: string) {
  track(name)
}

trackFeature("signup")
```

Supports:

* direct parameter propagation
* object property propagation
* destructuring propagation
* nested propagation

---

# Return Propagation

Eventra resolves parameter propagation through returned values.

```ts
function buildEvent(name: string) {
  return name
}

track(buildEvent("purchase"))
```

Powered by:

```ts
analyzeReturnPropagation()
```

---

# Caching

### `EvaluationCache`

Resolved value cache.

### `ResolvedCallCache`

Resolved function cache.

### `ResolvedExportCache`

Resolved export symbol cache.

### `WrapperRegistry`

Semantic wrapper registry.

---

# 4. EventraEngine

Central orchestration layer.

## Responsibilities

* Incremental analysis
* File synchronization
* Cache invalidation
* Dependency propagation
* Aggregation
* Batched updates

## Main APIs

```ts
preloadFile()
updateFile()
syncFile()
removeFile()
scanFile()
getAllEvents()
getDiagnostics()
```

---

# 5. CLI Layer

User-facing commands.

## Commands

### `eventra init`

Creates config.

### `eventra sync`

Scans project and updates:

* events
* wrappers
* propagation metadata

### `eventra check`

Validates config against source.

### `eventra watch`

Realtime incremental scanning.

### `eventra send`

Uploads events to backend.

---

# Detection Capabilities

## Direct Tracking

```ts
track("event")
tracker.track("event")
```

---

## Variables

```ts
const EVENT = "signup"

track(EVENT)
```

---

## Enums

```ts
track(EVENTS.LOGIN)
```

---

## Template Strings

```ts
track(`feature_${type}`)
```

---

## Conditional Expressions

```ts
track(isAdmin ? "admin" : "user")
```

---

## Arrays

```ts
track(["a", "b"])
```

---

## Object Payloads

```ts
track({
  event: "checkout"
})
```

---

## Function Wrappers

```ts
function trackFeature(name: string) {
  track(name)
}

trackFeature("click")
```

---

## Return Propagation

```ts
function build(name: string) {
  return name
}

track(build("purchase"))
```

---

## Cross-file Resolution

```ts
import { trackFeature } from "./tracker"

trackFeature("purchase")
```

---

# Incremental Architecture

Eventra does NOT rescan the whole project on every update.

Instead:

1. Updates changed file
2. Invalidates affected symbol caches
3. Rebuilds TS incrementally
4. Traverses dependency graph
5. Re-analyzes affected files only

---

# Goal

Static analytics extraction with:

* zero runtime overhead
* semantic propagation analysis
* cross-file resolution
* incremental performance
* CI/CD compatibility
