import path from "path";

const GLOB_CHARS = /[*?[\]{}()!]/;

/**
 * `sync.exclude` entries are written as bare directory names (`node_modules`,
 * `dist`). fast-glob only matches a bare name against the repo root, so a
 * nested `packages/x/node_modules` would still be scanned. A plain name is
 * therefore expanded to match at any depth; entries that already contain a
 * `/` or glob characters are left exactly as written.
 */
export function expandExcludePatterns(exclude: readonly string[]): string[] {
  const out = new Set<string>();
  for (const entry of exclude) {
    const pattern = entry.trim();
    if (!pattern) continue;
    if (pattern.includes("/") || GLOB_CHARS.test(pattern)) {
      out.add(pattern);
    } else {
      out.add(`**/${pattern}`);
      out.add(`**/${pattern}/**`);
    }
  }
  return [...out];
}

// fast-glob runs with dot:false: `*`, `**` and `?` never match a path segment
// that starts with a dot (.svelte-kit, .nuxt, .turbo, ...) unless the glob
// spells the dot itself (`.github/**`). The watch filter must agree, or
// generated output in those directories leaks in while `sync` ignores it.
const NO_DOT = "(?!\\.)";

/** Converts the glob subset used by eventra configs (`**`, `*`, `?`, `{a,b}`, `[..]`) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/^\.\//, "");
  let out = "";
  let braceDepth = 0;

  // a segment starts at the beginning, after a slash, or at a brace alternative
  const atSegmentStart = (i: number): boolean => i === 0 || "/{,".includes(source[i - 1]!);

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "*") {
      if (source[i + 1] === "*") {
        if (source[i + 2] === "/" && atSegmentStart(i)) {
          // zero or more whole segments, none of them hidden
          out += `(?:${NO_DOT}[^/]+/)*`;
          i += 2;
        } else if (i + 2 >= source.length && atSegmentStart(i)) {
          // trailing `**`: everything below, again without hidden segments
          out += `(?:${NO_DOT}[^/]+/)*(?:${NO_DOT}[^/]*)?`;
          i += 1;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += `${atSegmentStart(i) ? NO_DOT : ""}[^/]*`;
      }
    } else if (ch === "?") {
      out += `${atSegmentStart(i) ? NO_DOT : ""}[^/]`;
    } else if (ch === "{") {
      braceDepth++;
      out += "(?:";
    } else if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      out += ")";
    } else if (ch === "," && braceDepth > 0) {
      out += "|";
    } else if (ch === "[") {
      const end = source.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        out += source.slice(i, end + 1);
        i = end;
      }
    } else {
      out += ch.replace(/[.+^$()|\\\]]/g, "\\$&");
    }
  }

  return new RegExp(`^${out}$`);
}

export function toPosix(file: string): string {
  return file.replace(/\\/g, "/");
}

export interface FileFilter {
  /** True when the path is under an excluded entry (also usable for directories). */
  isExcluded(absPath: string): boolean;
  /** True when the path is not excluded and matches one of the include globs. */
  isIncluded(absPath: string): boolean;
}

/**
 * Mirrors what the initial fast-glob scan accepts, so watch mode reacts to the
 * same files as `sync`.
 */
export function createFileFilter(
  include: readonly string[],
  exclude: readonly string[],
  cwd: string,
  alwaysExcluded: readonly string[] = [],
): FileFilter {
  const includeRes = include.filter((p) => !p.startsWith("!")).map(globToRegExp);
  const negatedRes = include
    .filter((p) => p.startsWith("!"))
    .map((p) => globToRegExp(p.slice(1)));

  const excludeRes = exclude
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const globbed = p.includes("/") || GLOB_CHARS.test(p) ? p : `**/${p}`;
      return globToRegExp(globbed.replace(/\/+$/, ""));
    });

  const relative = (absPath: string): string => toPosix(path.relative(cwd, absPath));

  const isExcluded = (absPath: string): boolean => {
    const rel = relative(absPath);
    if (alwaysExcluded.includes(rel)) return true;
    const segments = rel.split("/");
    // test every leading prefix so a match on a directory excludes what is inside it
    for (let n = 1; n <= segments.length; n++) {
      const prefix = segments.slice(0, n).join("/");
      if (excludeRes.some((re) => re.test(prefix))) return true;
    }
    return false;
  };

  return {
    isExcluded,
    isIncluded(absPath: string): boolean {
      const rel = relative(absPath);
      if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return false;
      if (isExcluded(absPath)) return false;
      if (negatedRes.some((re) => re.test(rel))) return false;
      return includeRes.some((re) => re.test(rel));
    },
  };
}
