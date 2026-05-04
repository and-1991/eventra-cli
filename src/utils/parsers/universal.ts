import path from "path";
import { ParseResult } from "../../types";

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

    //  { ... }
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
        if (expr) result.push(expr);
        i = j;
        continue;
      }
    }

    //  attr="..."
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

      if (val.trim()) result.push(val.trim());

      i = j + 1;
      continue;
    }

    i++;
  }

  // Vue / Svelte handlers
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
 * - Astro
 * - Vue
 * - Svelte
 * - HTML + JS
 * - SSR / mixed files
 */

export function parseUniversal(
  content: string,
  file: string
): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  //  Astro frontmatter
  const fm = content.match(/^---([\s\S]*?)---/);
  if (fm?.[1]) parts.push(fm[1]);

  // <script src="">
  const scriptSrc = content.matchAll(
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
  const scripts = content.matchAll(
    /<script\b[^>]*>([\s\S]*?)<\/script>/g
  );

  for (const m of scripts) {
    if (m[1].trim()) parts.push(m[1]);
  }

  // JS <script>
  const noScripts = content.replace(
    /<script[\s\S]*?<\/script>/g,
    ""
  );

  const noHtml = noScripts
    .replace(/<[^>]+>/g, "\n")
    .replace(/\n+/g, "\n");

  if (noHtml.trim()) parts.push(noHtml);

  // expressions
  const extracted = extractJS(content);

  for (const e of extracted) {
    parts.push(e + ";");
  }

  return {
    code: [...new Set(parts)].join("\n"),
    deps,
  };
}
