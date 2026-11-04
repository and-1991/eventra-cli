/** Mirrors the length limit of @eventra_dev/eventra-sdk (see packages/sdk/src/client.ts). */
export const EVENTRA_SDK_PACKAGE = "@eventra_dev/eventra-sdk";
export const MAX_EVENT_NAME_LENGTH = 64;

export function isEventraSdkModuleSpecifier(specifier: string): boolean {
  const normalized = specifier.replace(/\\/g, "/");
  return (
    normalized === EVENTRA_SDK_PACKAGE ||
    normalized.startsWith(`${EVENTRA_SDK_PACKAGE}/`)
  );
}

/**
 * Control characters (tabs, newlines, NUL and the like) cannot be part of a name. Everything else is
 * accepted, as the SDK and the API accept it: letters of any language, digits, punctuation, emoji and
 * the plain space, so third-party names such as `App: User Sign Up`, PostHog's `$pageview` or
 * `Rocket 🚀` survive.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** Why `value` cannot be an event name, or null when it can. The reason is shown to the user. */
export function eventNameRejection(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "the name is empty";
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return "the name has control characters such as a tab or a line break";
  }
  return null;
}

/**
 * The name the SDK would send: trimmed, and cut to 64 characters exactly as `track()` does, so a longer
 * name is the same event in the catalog as it is at runtime. Null when it cannot be a name at all.
 */
export function normalizeEventName(value: string): string | null {
  if (eventNameRejection(value) !== null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > MAX_EVENT_NAME_LENGTH ? trimmed.slice(0, MAX_EVENT_NAME_LENGTH) : trimmed;
}

/** The declared dynamic names that are usable event names, trimmed and cut like the SDK does, once each, in order. */
export function normalizeDynamicEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.flatMap((item) => (typeof item === "string" ? [normalizeEventName(item)] : [])).filter((name): name is string => name !== null);
  return [...new Set(names)].sort();
}

export function isValidEventName(value: string): boolean {
  return normalizeEventName(value) !== null;
}

export const EVENTRA_SDK_SHIM = `declare module "@eventra_dev/eventra-sdk" {
  export interface TrackOptions {
    userId?: string;
    properties?: Record<string, unknown>;
  }
  export interface TrackerOptions {
    apiKey: string;
    endpoint?: string;
  }
  export class Eventra {
    constructor(options: TrackerOptions);
    track(name: string, options?: TrackOptions): void;
  }
}
`;
