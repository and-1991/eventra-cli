# Eventra CLI — Current Static Analysis Coverage

# High-Level Resolution Flow

```text
Source File
    |
    v
TypeScript AST
    |
    v
scanSource()
    |
    +-----------------------------+
    |                             |
    v                             v
Track Sink Detection       Wrapper Detection
    |                             |
    +-------------+---------------+
                  |
                  v
        Semantic Propagation
                  |
                  v
         extractEvents()
                  |
                  v
        resolveNodeValue()
                  |
                  v
         Final Event Names
```

---

# What Eventra Currently Resolves

## 1. Direct Tracking

```ts
track("signup")
analytics.track("purchase")
sdk?.track("checkout")
sdk["track"]("login")
```

✅ Supported

---

## 2. Variables

```ts
const EVENT = "checkout"
track(EVENT)
```

✅ Supported

---

## 3. String Concatenation

```ts
const BASE = "feature_"
const TYPE = "signup"

track(BASE + TYPE)
```

✅ Supported

---

## 4. Template Strings

```ts
const type = "login"
track(`feature_${type}`)
```

✅ Supported

---

## 5. Object Payloads

```ts
track({
  event: "checkout"
})
```

✅ Supported

---

## 6. Wrapper Functions

```ts
function trackFeature(event) {
  track(event)
}

trackFeature("signup")
```

✅ Supported

---

## 7. Wrapper With Multiple Arguments

```ts
function trackFeature(a, b, event) {
  track(event)
}

trackFeature(1, 2, "purchase")
```

✅ Supported

---

## 8. Cross-File Wrapper Resolution

```ts
// tracker.ts
export function trackFeature(event) {
  track(event)
}

// app.ts
import { trackFeature } from "./tracker"

trackFeature("checkout")
```

✅ Supported

---

## 9. Nested Wrapper Calls

```ts
function a(event) {
  b(event)
}

function b(name) {
  track(name)
}

a("purchase")
```

⚠️ Partially Supported

Works in many cases, but deep recursive interprocedural traversal is intentionally limited.

---

## 10. Property Propagation

```ts
function trackWrapper(payload) {
  track(payload.event)
}

trackWrapper({
  event: "checkout"
})
```

✅ Supported

---

## 11. Optional Property Propagation

```ts
track(payload?.event)
```

✅ Supported

---

## 12. Element Access Propagation

```ts
track(payload["event"])
sdk["track"]("signup")
```

✅ Supported

---

## 13. Destructured Parameters

```ts
function wrapper({ event }) {
  track(event)
}

wrapper({
  event: "signup"
})
```

✅ Supported

---

## 14. Aliased Destructuring

```ts
function wrapper({ event: name }) {
  track(name)
}
```

✅ Supported

---

## 15. Nested Destructuring

```ts
function wrapper({
  meta: { event }
}) {
  track(event)
}
```

✅ Supported

---

## 16. Return Propagation

```ts
function buildEvent(name) {
  return name
}

track(buildEvent("signup"))
```

✅ Supported

---

# Internal Architecture Chain

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

# Current Non-Goals

These are intentionally NOT supported yet:

* ❌ Runtime evaluation
* ❌ Async runtime state
* ❌ API/network-derived events
* ❌ Arbitrary function execution
* ❌ Dynamic eval()
* ❌ Reflection
* ❌ Full control-flow graph
* ❌ Full recursive interprocedural graph traversal
* ❌ Mutation tracking
* ❌ Full object graph evaluation
* ❌ Framework template analysis (moved to plugins)

---

# Current Engine Type

Eventra is currently:

```text
Incremental TypeScript Semantic Analysis Engine
```

NOT:

```text
Regex scanner
```

and NOT:

```text
Runtime instrumentation SDK
```

---

# Current Strengths

✅ Incremental TS compiler

✅ Symbol-aware analysis

✅ Cross-file resolution

✅ Semantic parameter propagation

✅ Property propagation

✅ Return propagation

✅ Partial static value evaluation

✅ Cache-based extraction

✅ Dependency graph invalidation

✅ TypeChecker-powered resolution

✅ Near-zero runtime cost

✅ Plugin-oriented architecture

## Overview

Eventra is an incremental semantic TypeScript analysis platform for static analytics event extraction.

The system consists of:

* semantic analysis core
* incremental TypeScript compiler engine
* propagation analysis layer
* plugin-oriented extraction architecture
* ingest and aggregation backend
* workspace-isolated analytics infrastructure

Eventra statically extracts analytics events from JavaScript and TypeScript codebases without runtime instrumentation.

---

# High-Level Architecture

```text
Source Files
     |
     v
TypeScript Compiler API
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
```

---

# Core Analysis Engine

## Engine Type

Eventra is:

```text
Incremental Semantic TypeScript Analysis Engine
```

NOT:

```text
Regex scanner
```

and NOT:

```text
Runtime instrumentation SDK
```

---

# Semantic Analysis Pipeline

## Resolution Flow

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

# Static Resolution Coverage

## Supported

### Direct tracking

```ts
track("signup")
analytics.track("purchase")
sdk?.track("checkout")
sdk["track"]("login")
```

---

### Variables

```ts
const EVENT = "signup"
track(EVENT)
```

---

### Enums

```ts
enum EVENTS {
  LOGIN = "login"
}

track(EVENTS.LOGIN)
```

---

### Template literals

```ts
track(`feature_${type}`)
```

---

### String concatenation

```ts
track("feature_" + type)
```

---

### Conditional expressions

```ts
track(flag ? "a" : "b")
```

---

### Arrays

```ts
track(["a", "b"])
```

---

### Object payloads

```ts
track({
  event: "signup"
})
```

---

### Shorthand payloads

```ts
track({ event })
```

---

### Wrapper functions

```ts
function trackFeature(event) {
  track(event)
}
```

---

### Multiple wrapper arguments

```ts
function wrapper(a, b, event) {
  track(event)
}
```

---

### Cross-file wrapper propagation

```ts
import { trackFeature } from "./tracker"
```

---

### Return propagation

```ts
function build(name) {
  return name
}

track(build("signup"))
```

---

### Property propagation

```ts
track(payload.event)
track(payload?.event)
track(payload["event"])
```

---

### Destructured parameters

```ts
function wrapper({ event }) {
  track(event)
}
```

---

### Aliased destructuring

```ts
function wrapper({ event: name }) {
  track(name)
}
```

---

### Nested destructuring

```ts
function wrapper({
  meta: { event }
}) {
  track(event)
}
```

---

# Incremental Analysis Engine

## Core Components

### CompilerContext

Maintains incremental TypeScript program state.

---

### Scheduler

Coordinates async file updates and incremental rebuilds.

---

### ImportGraph

Tracks dependency relationships between files.

Provides:

* dependent collection
* selective invalidation
* incremental rescans

---

### FileSemanticIndex

Stores:

* sinks
* wrappers
* track calls
* semantic metadata

---

# Cache Architecture

## EvaluationCache

Caches resolved identifier values.

---

## ResolvedCallCache

Caches resolved call targets.

---

## ResolvedExportCache

Caches normalized exported symbols.

---

## ReturnPropagationCache

Caches return propagation analysis.

---

# Cache Invalidation

Eventra invalidates only affected semantic state.

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

---

# Wrapper Propagation System

## WrapperRegistry

Stores semantic propagation metadata for wrappers.

Supports:

* local wrappers
* imported wrappers
* normalized exports
* parameter propagation
* property propagation

---

## Propagation Metadata

```ts
{
  sourceParameter,
  sourceParameterIndex,
  propertyPath,
  targetNode,
}
```

---

# Resolver Capabilities

## Current Resolver Supports

* identifier resolution
* export normalization
* enum resolution
* object literal resolution
* property access resolution
* wrapper-aware resolution
* return propagation
* static string evaluation
* partial interprocedural propagation

---

# Current Non-Goals

These are intentionally NOT supported yet.

## Runtime execution

```ts
fetch()
localStorage
process.env
```

---

## Dynamic evaluation

```ts
eval()
```

---

## Full control-flow graph

---

## Deep recursive interprocedural graph traversal

---

## Mutation tracking

```ts
payload.event = "x"
```

---

## Full object graph evaluation

---

## Async semantic propagation

```ts
await
Promise.then()
```

---

## Framework template analysis

Currently plugin-oriented and intentionally outside the core.

---

# Plugin-Oriented Architecture

## Design Goal

Eventra core is framework-agnostic.

The core engine does NOT contain:

* React-specific logic
* Vue-specific logic
* Svelte-specific logic
* analytics SDK implementations

Framework support is implemented via plugins.

---

# Planned Plugin Kernel

## Core Responsibilities

* AST traversal
* semantic resolution
* propagation analysis
* incremental compilation
* cache invalidation
* symbol normalization

---

## Plugin Responsibilities

* sink detection
* framework adapters
* SDK integrations
* custom propagation rules
* template extraction

---

# Planned Plugin API

```ts
export interface EventraPlugin {
  name: string;

  setup(
    api: EventraPluginAPI,
  ): void;
}
```

---

# Backend Architecture

# Tenant Hierarchy

```text
Workspace
   |
   v
Project
   |
   v
Feature
   |
   v
Event
```

Isolation enforced at:

* guards
* queries
* billing layer
* ingest pipeline

---

# Ingest Pipeline

```text
HTTP
  |
  v
DTO Validation
  |
  v
API Key Authentication
  |
  v
Workspace Billing Guard
  |
  v
Rate Limiter
  |
  v
Memory Buffer
  |
  v
Disk Buffer
  |
  v
PostgreSQL COPY
  |
  v
Partitioning
  |
  v
Rollup Aggregation
```

---

# Billing State Machine

States:

* active
* grace
* locked

Transitions enforced via:

```text
BillingLifecycleService
```

---

# Rollup Engine

Runs every minute.

Guarantees:

* advisory-lock single worker
* deterministic cursor progression
* incremental aggregation
* lag monitoring
* crash-safe resumability

---

# Failure Model

## Safe

* process crash
* DB restart
* duplicate events
* partial batch failure
* incremental rebuild interruption
* cache invalidation replay

---

## Future Work

* multi-region ingest
* cross-region clock reconciliation
* distributed aggregation
* multi-primary ingest

---

# Scaling Path

## Phase 1

Vertical PostgreSQL COPY scaling.

---

## Phase 2

Read replicas for aggregates.

---

## Phase 3

Workspace-level sharding.

---

## Phase 4

Multi-region ingest.

---

# Design Philosophy

## Core Principles

```text
Throughput first.
Correctness always.
Semantic analysis over regex matching.
Framework-agnostic core.
Incremental everything.
Plugins over hardcoded integrations.
```

---

# Current Strengths

✅ Incremental TypeScript compiler

✅ Semantic propagation engine

✅ Wrapper-aware extraction

✅ Cross-file resolution

✅ Static value evaluation

✅ Dependency-aware invalidation

✅ Cache-based semantic analysis

✅ TypeChecker-powered symbol resolution

✅ Near-zero runtime overhead

✅ Framework-agnostic architecture

✅ Plugin-oriented evolution path

---

# Current Project State

```text
Phase 0
Regex / AST scanning
        ↓

Phase 1
Semantic propagation engine
        ↓

Phase 1.5
Plugin kernel foundation
        ↓

Phase 2
Framework + SDK plugin ecosystem
        ↓

Phase 3
Semantic provenance graph
        ↓

Phase 4
Advanced interprocedural analysis
```

---

# Current Status

Eventra already operates as:

```text
Lightweight semantic TypeScript analysis platform
```

rather than:

```text
Simple event scanner
```

The current architecture is intentionally designed to support long-term evolution toward a full semantic event intelligence platform.
