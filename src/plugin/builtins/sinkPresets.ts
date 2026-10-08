/**
 * Built-in `sinks` presets, plus the npm packages each one is recognised by.
 *
 * Package names and what they export were checked against the npm registry and the packages' own
 * type declarations on 2026-10-08 (`pnpm check:presets` re-checks the names against the registry,
 * so a rename or a deprecation shows up there instead of as a silent detection gap).
 */

/** A rule with every preset already expanded away. */
export interface ResolvedSinkRule {
  /** Dotted call path to match, as a suffix: "posthog.capture" also matches "this.posthog.capture". */
  readonly callee: string;
  /** Zero-based index of the argument holding the event name. Default 0. */
  readonly nameArg: number;
  /** When the argument is an object literal, read the event name from this property. */
  readonly nameProperty?: string;
  /**
   * When set, the call's receiver (`x` in `x.capture(...)`, or the callee itself for a bare call)
   * must come from one of these npm packages: imported from it, or initialised from a call/`new`
   * of something imported from it (`const ph = usePostHog()`, `const client = new PostHog(key)`).
   */
  readonly modules?: readonly string[];
  /** Only match when the argument at `arg` is the string literal `equals`. */
  readonly when?: { readonly arg: number; readonly equals: string };
}

export interface PresetPackage {
  readonly name: string;
  /**
   * An older package that is deprecated or no longer maintained but still common in existing code,
   * so it keeps being recognised. The registry check tolerates a deprecation notice on these.
   */
  readonly legacy?: boolean;
  /**
   * Only a signal that the vendor is in use (found in package.json): the preset's rules do not need
   * to vet a receiver against it, because it works through a global or an auto-import.
   */
  readonly detectOnly?: boolean;
}

const pkg = (name: string, flags: Omit<PresetPackage, "name"> = {}): PresetPackage => ({ name, ...flags });

export const PRESET_PACKAGES: Readonly<Record<string, readonly PresetPackage[]>> = {
  posthog: [
    pkg("posthog-js"),
    pkg("@posthog/react"),
    pkg("posthog-js-lite"),
    pkg("posthog-node"),
    pkg("posthog-react-native"),
  ],
  segment: [
    pkg("@segment/analytics-next"),
    pkg("@segment/analytics-node"),
    pkg("@segment/analytics-react-native"),
    pkg("@segment/analytics.js-core", { legacy: true }),
    pkg("analytics-node", { legacy: true }),
    pkg("@segment/snippet", { detectOnly: true }),
  ],
  amplitude: [
    pkg("@amplitude/analytics-browser"),
    pkg("@amplitude/analytics-node"),
    pkg("@amplitude/analytics-react-native"),
    pkg("@amplitude/marketing-analytics-browser"),
    pkg("@amplitude/unified"),
    pkg("amplitude-js", { legacy: true }),
  ],
  ga4: [
    pkg("react-ga4"),
    pkg("vue-gtag"),
    pkg("vue-gtag-next", { legacy: true }),
    pkg("@next/third-parties", { detectOnly: true }),
    pkg("nuxt-gtag", { detectOnly: true }),
    pkg("@types/gtag.js", { detectOnly: true }),
  ],
};

/** Packages a rule can vet a receiver against: everything except the detect-only signals. */
const modulesOf = (preset: string, only?: readonly string[]): string[] =>
  PRESET_PACKAGES[preset]
    .filter((p) => !p.detectOnly && (only === undefined || only.includes(p.name)))
    .map((p) => p.name);

export const SINK_PRESETS: Readonly<Record<string, readonly ResolvedSinkRule[]>> = {
  posthog: [
    // posthog.capture("x") - the conventional name, posthog-js and posthog-node alike.
    { callee: "posthog.capture", nameArg: 0, nameProperty: "event" },
    // Any other receiver name, e.g. `const ph = usePostHog(); ph.capture("x")` or
    // `const client = new PostHog(key); client.capture({ distinctId, event: "x" })`.
    { callee: "capture", nameArg: 0, nameProperty: "event", modules: modulesOf("posthog") },
  ],
  segment: [
    // analytics.track("x", props) from analytics.js / @segment/analytics-next, `window.analytics` included;
    // analytics-node takes `analytics.track({ userId, event: "x" })`.
    { callee: "analytics.track", nameArg: 0, nameProperty: "event" },
    // `const [analytics] = await AnalyticsBrowser.load(...)`, `new Analytics({ writeKey })`, any variable name.
    { callee: "track", nameArg: 0, nameProperty: "event", modules: modulesOf("segment") },
  ],
  amplitude: [
    // amplitude.track("x") / amplitude.track({ event_type: "x" }) / the legacy amplitude.logEvent("x").
    { callee: "amplitude.track", nameArg: 0, nameProperty: "event_type" },
    { callee: "amplitude.logEvent", nameArg: 0, nameProperty: "event_type" },
    // `amplitude.getInstance().logEvent("x")`, `const client = Amplitude.createInstance()`, any variable name.
    { callee: "track", nameArg: 0, nameProperty: "event_type", modules: modulesOf("amplitude") },
    { callee: "logEvent", nameArg: 0, nameProperty: "event_type", modules: modulesOf("amplitude") },
  ],
  ga4: [
    // gtag("event", "x", params): the name is the second argument, and only for the "event" command
    // (`gtag("config", id)` and `gtag("set", ...)` are not events). `window.gtag` and nuxt-gtag's
    // `const { gtag } = useGtag()` match too.
    { callee: "gtag", nameArg: 1, when: { arg: 0, equals: "event" } },
    // @next/third-parties: sendGAEvent("event", "x", params).
    { callee: "sendGAEvent", nameArg: 1, when: { arg: 0, equals: "event" } },
    // nuxt-gtag: useTrackEvent("x", params), auto-imported.
    { callee: "useTrackEvent", nameArg: 0 },
    // vue-gtag: this.$gtag.event("x", params).
    { callee: "$gtag.event", nameArg: 0 },
    // vue-gtag: `import { event } from "vue-gtag"` or `const { event } = useGtag()`.
    { callee: "event", nameArg: 0, modules: modulesOf("ga4", ["vue-gtag", "vue-gtag-next"]) },
    // react-ga4: ReactGA.event("x", params) or ReactGA.event({ category, action: "x" }).
    { callee: "event", nameArg: 0, nameProperty: "action", modules: modulesOf("ga4", ["react-ga4"]) },
  ],
};

export interface DetectedPreset {
  readonly preset: string;
  /** The package.json dependencies that triggered it. */
  readonly packages: readonly string[];
}

/** Which presets a project's dependency names point at, in preset order. */
export function detectSinkPresets(dependencyNames: ReadonlySet<string>): DetectedPreset[] {
  const detected: DetectedPreset[] = [];
  for (const [preset, packages] of Object.entries(PRESET_PACKAGES)) {
    const present = packages.map((p) => p.name).filter((name) => dependencyNames.has(name));
    if (present.length > 0) detected.push({ preset, packages: present });
  }
  return detected;
}
