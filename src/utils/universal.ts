import path from "path";
import { ParseResult } from "../types";

// Remove comments
function stripComments(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

// Basic filter
function looksLikeTracking(code: string) {
  return /track/i.test(code);
}

// HTML inline handlers (onclick="")
function extractHTMLHandlers(input: string): string[] {
  const result: string[] = [];

  const matches = input.matchAll(
    /\bon\w+\s*=\s*["']([^"']+)["']/g
  );

  for (const m of matches) {
    if (looksLikeTracking(m[1])) {
      result.push(m[1]);
    }
  }

  return result;
}

// Vue handlers (@click / v-on)
function extractVueHandlers(input: string): string[] {
  const result: string[] = [];

  const matches = input.matchAll(
    /(?:@|v-on:)[\w:-]+\s*=\s*["']([^"']+)["']/g
  );

  for (const m of matches) {
    if (looksLikeTracking(m[1])) {
      result.push(m[1]);
    }
  }

  return result;
}

// Svelte handlers (on:click)
function extractSvelteHandlers(input: string): string[] {
  const result: string[] = [];

  const matches = input.matchAll(
    /\bon:[\w]+\s*=\s*{([^}]+)}/g
  );

  for (const m of matches) {
    if (looksLikeTracking(m[1])) {
      result.push(m[1]);
    }
  }

  return result;
}

// JSX / template { ... }
function extractJSExpressions(input: string): string[] {
  const result: string[] = [];

  const matches = input.matchAll(/\{([^}]+)\}/g);

  for (const m of matches) {
    if (looksLikeTracking(m[1])) {
      result.push(m[1]);
    }
  }

  return result;
}

// dynamic import()
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

    if (looksLikeTracking(mod)) {
      calls.push(`import("${mod}")`);
    }
  }

  return { deps, calls };
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
    if (m[2].trim()) {
      parts.push(m[2]);
    }
  }

  // TEMPLATE PART
  const noScripts = clean.replace(
    /<script[\s\S]*?<\/script>/g,
    ""
  );

  // handlers
  parts.push(...extractHTMLHandlers(noScripts));
  parts.push(...extractVueHandlers(noScripts));
  parts.push(...extractSvelteHandlers(noScripts));

  // JSX / Astro / Vue expressions
  parts.push(...extractJSExpressions(clean));

  // dynamic imports
  const dyn = extractDynamicImports(clean, file);
  deps.push(...dyn.deps);
  parts.push(...dyn.calls);

  return {
    code: [...new Set(parts)].join("\n"),
    deps: [...new Set(deps.filter(Boolean))],
  };
}
