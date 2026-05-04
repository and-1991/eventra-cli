import path from "path";
import { ParseResult } from "../types";

/**
 * Strip comments (HTML + JS)
 */
function stripComments(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/**
 * Extract JS expressions
 */
function extractJS(input: string): string[] {
  const result: string[] = [];

  let i = 0;
  const len = input.length;

  let inString: '"' | "'" | "`" | null = null;
  let escape = false;

  while (i < len) {
    const ch = input[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === inString) inString = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i++;
      continue;
    }

    if (ch === "{") {
      let depth = 1;
      let j = i + 1;

      while (j < len && depth > 0) {
        if (input[j] === "{") depth++;
        else if (input[j] === "}") depth--;
        j++;
      }

      if (depth === 0) {
        const expr = input.slice(i + 1, j - 1).trim();

        if (expr && /[a-zA-Z0-9_$]\s*\(/.test(expr)) {
          result.push(expr);
        }

        i = j;
        continue;
      }
    }

    i++;
  }

  return result;
}

/**
 * Loose JS extractor
 */
function extractLooseJS(input: string): string[] {
  const result: string[] = [];

  const lines = input.split("\n");

  for (const line of lines) {
    const l = line.trim();

    if (!l) continue;
    if (l.startsWith("<")) continue;

    if (/[a-zA-Z0-9_$]\s*\(/.test(l)) {
      result.push(l);
    }
  }

  return result;
}

/**
 * UNIVERSAL PARSER
 * Support:
 * - React / JSX
 * - Vue
 * - Svelte
 * - Astro
 * - HTML + JS
 * - SSR
 */
export function parseUniversal(
  content: string,
  file: string
): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  const clean = stripComments(content);

  // ASTRO FRONTMATTER
  const fm = clean.match(/^---([\s\S]*?)---/);
  if (fm?.[1]) {
    parts.push(fm[1]);
  }

  // <script src="">
  const scriptSrc = clean.matchAll(
    /<script\b[^>]*?\bsrc=["'](.+?)["'][^>]*>/g
  );

  for (const s of scriptSrc) {
    const src = s[1];

    const resolved = src.startsWith("/")
      ? path.resolve(process.cwd(), "." + src)
      : path.resolve(path.dirname(file), src);

    deps.push(resolved);
  }

  // INLINE <script>
  const scripts = clean.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/g
  );

  for (const m of scripts) {
    const attrs = m[1];

    // skip JSON
    if (/type=["']application\/json/.test(attrs)) continue;

    if (m[2].trim()) {
      parts.push(m[2]);
    }
  }

  // REMOVE SCRIPTS → TEMPLATE PART
  const noScripts = clean.replace(
    /<script[\s\S]*?<\/script>/g,
    ""
  );

  // LOOSE JS
  parts.push(...extractLooseJS(noScripts));

  // EXPRESSIONS
  const extracted = extractJS(clean);
  for (const e of extracted) {
    parts.push(e + ";");
  }

  // RESULT
  return {
    code: [...new Set(parts)].join("\n"),
    deps: [...new Set(deps.filter(Boolean))],
  };
}
