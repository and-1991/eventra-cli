import path from "path";
import { ParseResult } from "../types";

// Strip comments (HTML + JS)
function stripComments(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

// Extract JS expressions inside {}
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

// Extract inline HTML handlers
function extractInlineHandlers(input: string): string[] {
  const result: string[] = [];

  const matches = input.matchAll(
    /\bon\w+\s*=\s*["']([^"']+)["']/g
  );

  for (const m of matches) {
    const code = m[1];
    if (/[a-zA-Z0-9_$]\s*\(/.test(code)) {
      result.push(code);
    }
  }

  return result;
}

// Extract dynamic imports
function extractDynamicImports(
  input: string,
  file: string
): { deps: string[]; calls: string[] } {
  const deps: string[] = [];
  const calls: string[] = [];

  const matches = input.matchAll(
    /import\(\s*["'](.+?)["']\s*\)/g
  );

  for (const m of matches) {
    const mod = m[1];

    const resolved = mod.startsWith("/")
      ? path.resolve(process.cwd(), "." + mod)
      : path.resolve(path.dirname(file), mod);

    deps.push(resolved);
    calls.push(`import("${mod}")`);
  }

  return { deps, calls };
}

// Filter only probable tracking-related code
function isProbablyTracking(code: string): boolean {
  return /track|event|analytics/i.test(code);
}

// UNIVERSAL PARSER
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

  // INLINE HANDLERS
  parts.push(
    ...extractInlineHandlers(noScripts).filter(isProbablyTracking)
  );

  // DYNAMIC IMPORTS
  const dyn = extractDynamicImports(clean, file);
  deps.push(...dyn.deps);
  parts.push(...dyn.calls.filter(isProbablyTracking));

  // EXPRESSIONS
  const extracted = extractJS(clean);

  for (const e of extracted) {
    if (isProbablyTracking(e)) {
      parts.push(e + ";");
    }
  }

  return {
    code: [...new Set(parts)].join("\n"),
    deps: [...new Set(deps.filter(Boolean))],
  };
}
