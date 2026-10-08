import type { DynamicOccurrence } from "./analysis/shared/dynamicOccurrence";

export interface ScanResult {
  readonly events: Set<string>;
  readonly detectedFunctionWrappers: Set<string>;
  readonly dynamicOccurrences: readonly DynamicOccurrence[];
}

export interface FunctionWrapperConfig {
  name: string;
}

/**
 * Declares a third-party analytics call as an event sink. Either a `preset` (e.g. "posthog")
 * or a `callee` with optional matching details. Declarative only - safe to commit.
 */
export interface SinkRuleConfig {
  /** Built-in rule set, e.g. "posthog". */
  preset?: string;
  /** Dotted call path, matched as a suffix: "analytics.track" matches "this.analytics.track". */
  callee?: string;
  /** Zero-based index of the event-name argument. Default 0. */
  nameArg?: number;
  /** When that argument is an object literal, read the name from this property (e.g. "event"). */
  nameProperty?: string;
  /** Require the receiver to come from one of these npm packages. */
  modules?: string[];
  /** Only match when the argument at `arg` is the string literal `equals` (e.g. `gtag("event", name)`). */
  when?: { arg: number; equals: string };
}

export interface EventraConfig {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly events: string[];
  functionWrappers?: FunctionWrapperConfig[];
  /** Third-party analytics calls to treat as event sinks (e.g. `{ "preset": "posthog" }`). */
  sinks?: SinkRuleConfig[];
  /** Module specifiers for CLI plugins (e.g. "@eventra_dev/cli-plugin-vue"). */
  readonly plugins?: readonly string[];
  readonly sync: {
    readonly include: string[];
    readonly exclude: string[];
  };
}
