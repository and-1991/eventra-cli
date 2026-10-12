// Files above this size are generated or vendored output (bundles, minified
// code, big fixtures), not something to analyse. One limit for every command,
// so `sync` and `watch` can never disagree about a file.
export const MAX_FILE_CHARS = 2_000_000;

export const OVERSIZED_REASON = "file is larger than 2 MB";

export function isOversized(content: string): boolean {
  return content.length > MAX_FILE_CHARS;
}
