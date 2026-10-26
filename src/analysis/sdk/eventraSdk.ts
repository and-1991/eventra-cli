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
 * Letters, digits and `$ : _ . / -`, plus the plain space - so third-party names such as
 * `App: User Sign Up` and PostHog's own `$pageview` survive. The SDK and the API accept any text up
 * to the length limit; the CLI stays stricter so that a name read out of code is a clean identifier:
 * tabs, newlines and every other character are rejected.
 */
const EVENT_NAME_PATTERN = /^[a-zA-Z0-9$:_./ -]+$/;

/** Why `value` cannot be an event name, or null when it can. The reason is shown to the user. */
export function eventNameRejection(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "the name is empty";
  }
  if (trimmed.length > MAX_EVENT_NAME_LENGTH) {
    return `the name is longer than ${MAX_EVENT_NAME_LENGTH} characters`;
  }
  if (!EVENT_NAME_PATTERN.test(trimmed)) {
    return "the name has characters other than letters, digits and $ : _ . / - and space";
  }
  return null;
}

export function normalizeEventName(value: string): string | null {
  return eventNameRejection(value) === null ? value.trim() : null;
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
