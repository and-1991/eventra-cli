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
 * What a real event name is made of: letters, marks and digits of any language (`Заказ оформлен`, `购买完成`),
 * the plain space, and the punctuation names actually use: `$ : _ . / -` (`App: User Sign Up`, PostHog's
 * `$pageview`), brackets and parentheses (Amplitude's `[Amplitude] Page Viewed`, `Checkout (v2)`), and
 * `# @ + & , '` (`Save & Continue`, `User's Profile Viewed`). The SDK and the API accept any text; the CLI stays
 * stricter so that a name read out of code is a clean identifier: emoji, control characters (tabs, newlines),
 * `!`, `?` and the rest are rejected and listed, not guessed at.
 */
const EVENT_NAME_PATTERN = /^[\p{L}\p{M}\p{N}$:_./ \-[\]()#@+&,']+$/u;

/** The reason shown for a name with other characters. */
export const REJECTED_CHARACTERS_REASON = "the name has characters other than letters, digits and $ : _ . / - [ ] ( ) # @ + & , ' and space";

// half of a surrogate pair (a character outside the basic plane cut in the middle by the 64 limit): the server drops
// these from a name, because a database text column cannot hold them
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The name the SDK would send and the server would store: trimmed, cut to 64 characters exactly as `track()`
 * does (which can split a character outside the basic plane in two), and without a lone surrogate, as the
 * server's own cleaning leaves it, so a longer name is the same event in the catalog as it is at runtime.
 */
function stored(value: string): string {
  const trimmed = value.trim();
  const cut = trimmed.length > MAX_EVENT_NAME_LENGTH ? trimmed.slice(0, MAX_EVENT_NAME_LENGTH) : trimmed;
  return cut.replace(LONE_SURROGATE, "").trim();
}

/** Why `value` cannot be an event name, or null when it can. The reason is shown to the user. */
export function eventNameRejection(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "the name is empty";
  }
  if (!EVENT_NAME_PATTERN.test(trimmed)) {
    return REJECTED_CHARACTERS_REASON;
  }
  return null;
}

/** The name as the catalog will hold it. Null when it cannot be a name at all. */
export function normalizeEventName(value: string): string | null {
  return eventNameRejection(value) === null ? stored(value) : null;
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
