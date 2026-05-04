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
 * Extract JS expressions safely
 */
function extractJS(input: string): string[] {
  const result: string[] = [];

  let i = 0;
  const len = input.length;

  let inString: '"' | "'" | "`" | null = null;
  let escape = false;

  while (i < len) {
    const ch = input[i];

    // STRING
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

    // { ... }
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;

      let innerStr: '"' | "'" | "`" | null = null;
      let innerEsc = false;

      while (j < len && depth > 0) {
        const c = input[j];

        if (innerStr) {
          if (innerEsc) innerEsc = false;
          else if (c === "\\") innerEsc = true;
          else if (c === innerStr) innerStr = null;
          j++;
          continue;
        }

        if (c === '"' || c === "'" || c === "`") {
          innerStr = c;
          j++;
          continue;
        }

        if (c === "{") depth++;
        else if (c === "}") depth--;

        j++;
      }

      if (depth === 0) {
        const expr = input.slice(i + 1, j - 1).trim();

        if (
          expr &&
          (expr.includes("(") ||
            expr.includes("=") ||
            expr.includes(".") ||
            expr.includes("track"))
        ) {
          result.push(expr);
        }

        i = j;
        continue;
      }
    }

    // attr="..."
    if (ch === "=" && (input[i + 1] === '"' || input[i + 1] === "'")) {
      const quote = input[i + 1];
      let j = i + 2;
      let val = "";

      while (j < len) {
        const c = input[j];

        if (c === "\\" && input[j + 1]) {
          val += c + input[j + 1];
          j += 2;
          continue;
        }

        if (c === quote) break;

        val += c;
        j++;
      }

      if (
        val.trim() &&
        (val.includes("(") ||
          val.includes("=>") ||
          val.includes("track"))
      ) {
        result.push(val.trim());
      }

      i = j + 1;
      continue;
    }

    i++;
  }

  // Vue / Svelte / JSX handlers
  const extra = [
    /@[\w-]+\s*=\s*["']([\s\S]*?)["']/g,
    /v-on:[\w-]+\s*=\s*["']([\s\S]*?)["']/g,
    /on:[\w-]+\s*=\s*{([\s\S]*?)}/g,
    /on\w+\s*=\s*{([\s\S]*?)}/g,
  ];

  for (const r of extra) {
    const m = input.matchAll(r);
    for (const x of m) {
      const v = x[1]?.trim();
      if (v) result.push(v);
    }
  }

  return result;
}

/**
 * Extract loose JS but less noisy
 */
function extractLooseJS(input: string): string[] {
  const result: string[] = [];

  const lines = input.split("\n");

  for (const line of lines) {
    const l = line.trim();

    if (!l) continue;
    if (l.startsWith("<")) continue;

    // strict filter
    if (
      l.includes("track") ||
      l.includes(".track(") ||
      l.includes("=>") ||
      l.startsWith("function") ||
      l.includes("(")
    ) {
      result.push(l);
    }
  }

  return result;
}

/**
 * Universal parser
 */
export function parseUniversal(
  content: string,
  file: string
): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  const clean = stripComments(content);

  // Astro frontmatter
  const fm = clean.match(/^---([\s\S]*?)---/);
  if (fm?.[1]) parts.push(fm[1]);

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

  // inline <script>
  const scripts = clean.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/g
  );

  for (const m of scripts) {
    const attrs = m[1];

    // skip JSON / data
    if (/type=["']application\/json/.test(attrs)) continue;

    if (m[2].trim()) {
      parts.push(m[2]);
    }
  }

  // remove scripts
  const noScripts = clean.replace(
    /<script[\s\S]*?<\/script>/g,
    ""
  );

  // loose JS
  const loose = extractLooseJS(noScripts);
  parts.push(...loose);

  // expressions
  const extracted = extractJS(clean);
  for (const e of extracted) {
    parts.push(e + ";");
  }

  return {
    code: [...new Set(parts)].join("\n"),
    deps,
  };
}
