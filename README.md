# Eventra CLI

Eventra CLI automatically discovers feature usage events in your codebase and syncs them with Eventra.

It helps you:

- Automatically discover events
- Detect wrapper components
- Keep events in sync
- Register features in Eventra
- Works with any JS framework (React, Vue, Svelte, Node, etc.)

---

# Installation

Using npm

```bash
npm install -D @eventra_dev/eventra-cli
```

Using pnpm

```bash
pnpm add -D @eventra_dev/eventra-cli
```

Using npx

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

Creates `eventra.json` config file.

```bash
eventra init
```

Example:

```json
{
  "apiKey": "",
  "events": [],
  "wrappers": [],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".next", ".git"]
  }
}
```

---

## eventra sync

Scans your project and finds all tracking events automatically.

```bash
eventra sync
```

Eventra CLI searches for:

### Direct tracking calls

```ts
tracker.track("feature_created")
```

### Wrapper components

```tsx
<TrackedButton event="feature_created" />
```

### Custom wrappers

```tsx
<MyComponent event="user_signup" />
```

---

# Wrapper detection

If you use wrapper components, Eventra CLI will ask:

```
Use wrapper components? (Y/n)
```

Then:

```
Wrapper component name:
> TrackedButton
```

```
Event prop name:
> event
```

You can add multiple wrappers:

```
Add another wrapper? (y/N)
```

Example config:

```json
{
  "wrappers": [
    {
      "name": "TrackedButton",
      "prop": "event"
    },
    {
      "name": "Feature",
      "prop": "name"
    }
  ]
}
```

---

# Example sync output

```bash
eventra sync
```

Output:

```
Scanning project...

Found events:

- landing_login_clicked
- feature_created
- user_signup
```

---

# Diff detection

Eventra CLI automatically detects changes:

```
Changes:

New events:
+ landing_signup_clicked

Removed events:
- old_event
```

---

## eventra send

Send events to Eventra backend.

```bash
eventra send
```

If API key is missing:

```
API key is not configured
Enter your API key:
```

Events are registered in Eventra.

Example output:

```
Events registered successfully

New events:
+ feature_created
```

---

# Example workflow

```bash
eventra init
eventra sync
eventra send
```

---

# Configuration

eventra.json

```json
{
  "apiKey": "",
  "events": [],
  "wrappers": [],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".next", ".git"]
  }
}
```

---

# Supported patterns

## Direct tracking

```ts
tracker.track("feature_created")
```

## Wrapper components

```tsx
<TrackedButton event="feature_created" />
```

## Custom wrapper props

```tsx
<MyComponent eventName="user_signup" />
```

---

# Supported frameworks

Eventra CLI works with:

- React
- Next.js
- Vue
- Nuxt
- Svelte
- Astro
- Node.js
- Express
- NestJS
- Vanilla JavaScript

---

# Important

Eventra CLI detects only string literals:

Supported:

```ts
track("event_name")
```

Not supported:

```ts
track(eventName)
track(EVENTS.event)
track(getEvent())
```

This ensures reliable and predictable event detection.

---

# Requirements

- Node.js 18+
- JavaScript / TypeScript project

---

# License

MIT
