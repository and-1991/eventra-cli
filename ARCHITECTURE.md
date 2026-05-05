# Eventra CLI Architecture

## High-Level Flow

FILES → parseUniversal → TSService → scanSource → Engine → CLI

---

## Diagram

```
                +-------------------+
                |   Source Files    |
                +---------+---------+
                          |
                          v
                +-------------------+
                |  parseUniversal   |
                | (normalize input) |
                +---------+---------+
                          |
                          v
                +-------------------+
                |    TSService      |
                | (AST + Types)     |
                +---------+---------+
                          |
                          v
                +-------------------+
                |    scanSource     |
                | (core analyzer)   |
                +----+------+-------+
                     |      |
                     |      |
                     v      v
          +----------------+----------------+
          |                                 |
+-------------------+            +-----------------------+
| Function Wrappers |            | Component Wrappers    |
+-------------------+            +-----------------------+
          |                                 |
          +---------------+-----------------+
                          |
                          v
                +-------------------+
                | resolveNodeValue  |
                | (extract values)  |
                +---------+---------+
                          |
                          v
                +-------------------+
                | EventraEngine     |
                | (orchestration)   |
                +---------+---------+
                          |
                          v
                +-------------------+
                | CLI (sync/check)  |
                +-------------------+
```

---

## Modules

### Parser
Extracts JS from any framework (Vue, Svelte, Astro, HTML).

### TSService
Provides TypeScript AST and type resolution.

### Scanner
Finds:
- track() calls
- wrappers
- values

### Engine
Handles:
- caching
- dependency graph
- incremental updates

---

## Goal

Static analytics extraction without runtime.
