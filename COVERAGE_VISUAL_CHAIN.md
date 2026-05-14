# Eventra — Current Static Analysis Coverage

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
```

```text
track("signup")
      |
      v
StringLiteral
      |
      v
Event = "signup"
```

✅ Supported

---

# 2. Variables

```ts
const EVENT = "checkout"
track(EVENT)
```

```text
Identifier(EVENT)
        |
        v
VariableDeclaration
        |
        v
Initializer
        |
        v
"checkout"
```

✅ Supported

---

# 3. String Concatenation

```ts
const BASE = "feature_"
const TYPE = "signup"

track(BASE + TYPE)
```

```text
BinaryExpression(+)
     /        \
    v          v
"feature_"  "signup"
     \        /
      v      v
   concat(values)
         |
         v
"feature_signup"
```

✅ Supported

---

# 4. Template Strings

```ts
const type = "login"
track(`feature_${type}`)
```

```text
TemplateExpression
       |
       v
TemplateSpan(type)
       |
       v
Identifier Resolution
       |
       v
"login"
       |
       v
"feature_login"
```

✅ Supported

---

# 5. Object Payloads

```ts
track({
  event: "checkout"
})
```

```text
ObjectLiteral
      |
      v
PropertyAssignment(event)
      |
      v
"checkout"
```

✅ Supported

---

# 6. Wrapper Functions

```ts
function trackFeature(event) {
  track(event)
}

trackFeature("signup")
```

```text
track(event)
      |
      v
Parameter(event)
      |
      v
sourceParameterIndex = 0
      |
      v
trackFeature("signup")
      |
      v
call.arguments[0]
      |
      v
"signup"
```

✅ Supported

---

# 7. Wrapper With Multiple Arguments

```ts
function trackFeature(a, b, event) {
  track(event)
}

trackFeature(1, 2, "purchase")
```

```text
track(event)
      |
      v
Parameter(event)
      |
      v
sourceParameterIndex = 2
      |
      v
trackFeature(1, 2, "purchase")
      |
      v
call.arguments[2]
      |
      v
"purchase"
```

✅ Supported

---

# 8. Cross-File Wrapper Resolution

```ts
// tracker.ts
export function trackFeature(event) {
  track(event)
}

// app.ts
import { trackFeature } from "./tracker"

trackFeature("checkout")
```

```text
ImportDeclaration
       |
       v
resolveExportedSymbol()
       |
       v
Resolved Function Symbol
       |
       v
WrapperRegistry
       |
       v
Propagation Extraction
       |
       v
"checkout"
```

✅ Supported

---

# 9. Nested Wrapper Calls

```ts
function a(event) {
  b(event)
}

function b(name) {
  track(name)
}

a("purchase")
```

```text
Call a("purchase")
        |
        v
Parameter Propagation
        |
        v
b(event)
        |
        v
track(name)
        |
        v
"purchase"
```

⚠️ Partially Supported

Works in many cases, but deep interprocedural propagation is not fully complete yet.

---

# 10. Property Propagation

```ts
function trackWrapper(payload) {
  track(payload.event)
}

trackWrapper({
  event: "checkout"
})
```

```text
payload.event
      |
      v
PropertyAccessExpression
      |
      v
ObjectLiteralArgument
      |
      v
Property(event)
      |
      v
"checkout"
```

✅ Supported

---

# 11. Destructured Parameters

```ts
function wrapper({ event }) {
  track(event)
}

wrapper({
  event: "signup"
})
```

```text
ObjectBindingPattern
        |
        v
Parameter Binding
        |
        v
track(event)
        |
        v
"signup"
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

- ❌ Runtime evaluation
- ❌ Async runtime state 
- ❌ API/network-derived events 
- ❌ Arbitrary function execution 
- ❌ Dynamic eval()
- ❌ Reflection 
- ❌ Full control-flow graph 
- ❌ Full recursive interprocedural graph traversal
- ❌ Framework template analysis (currently disabled)

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
✅ Partial static value evaluation
✅ Cache-based extraction
✅ Dependency graph invalidation
✅ TypeChecker-powered resolution
✅ Near-zero runtime cost
