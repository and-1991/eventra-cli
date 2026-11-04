// Files above this size are generated or vendored output (bundles, minified
// code, big fixtures), not something to analyse. One limit for every command,
// so `sync` and `watch` can never disagree about a file. A project whose own
// source is bigger can raise it with `sync.maxFileSize` in eventra.json.
export const MAX_FILE_CHARS = 2_000_000;

export const OVERSIZED_REASON = "file is larger than 2 MB";

/** The limit in force: the project's `sync.maxFileSize` when it is a positive whole number, else the default. */
export function fileLimit(configured?: unknown): number {
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0 ? configured : MAX_FILE_CHARS;
}

/** Why a file over `limit` is not analysed; names the limit only when the project changed it. */
export function oversizedReason(limit: number = MAX_FILE_CHARS): string {
  return limit === MAX_FILE_CHARS ? OVERSIZED_REASON : `file is larger than ${limit} characters (sync.maxFileSize)`;
}

export function isOversized(content: string, limit: number = MAX_FILE_CHARS): boolean {
  return content.length > limit;
}
