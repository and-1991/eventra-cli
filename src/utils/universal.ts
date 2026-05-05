import path from "path";
import { ParseResult } from "../types";

// SAFE COMMENT STRIP
function stripComments(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

// TRACK FILTER
function looksLikeTracking(code: string) {
  return /\btrack\w*\s*\(/.test(code);
}

// SAFE {} PARSER
function extractBracedExpressions(input: string): string[] {
  const result: string[] = [];

  let depth = 0;
  let start = -1;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const expr = input.slice(start, i);
        if (looksLikeTracking(expr)) {
          result.push(expr);
        }
        start = -1;
      }
    }
  }

  return result;
}

// HTML handlers
function extractHTMLHandlers(input: string): string[] {
  const result: string[] = [];

  const regex = /\bon\w+\s*=\s*["']([^"']+)["']/g;

  for (const m of input.matchAll(regex)) {
    if (looksLikeTracking(m[1])) {
      result.push(m[1]);
    }
  }

  return result;
}

// VUE handlers
function extractVueHandlers(input: string): string[] {
  const result: string[] = [];

  const regex = /(?:@|v-on:)[\w:-]+\s*=\s*["']([^"']+)["']/g;

  for (const m of input.matchAll(regex)) {
    if (looksLikeTracking(m[1])) {
      result.push(m[1]);
    }
  }

  return result;
}

// SVELTE handlers
function extractSvelteHandlers(input: string): string[] {
  const result: string[] = [];

  const regex = /\bon:[\w]+\s*=\s*{([^}]+)}/g;

  for (const m of input.matchAll(regex)) {
    if (looksLikeTracking(m[1])) {
      result.push(m[1]);
    }
  }

  return result;
}

// SCRIPT EXTRACTION
function extractScripts(input: string, file: string) {
  const scripts: string[] = [];
  const deps: string[] = [];

  // src scripts
  const srcRegex =
    /<script\b[^>]*?\bsrc=["'](.+?)["'][^>]*>/g;

  for (const m of input.matchAll(srcRegex)) {
    const src = m[1];

    const resolved = src.startsWith("/")
      ? path.resolve(process.cwd(), "." + src)
      : path.resolve(path.dirname(file), src);

    deps.push(resolved);
  }

  // inline scripts
  const scriptRegex =
    /<script\b[^>]*>([\s\S]*?)<\/script>/g;

  for (const m of input.matchAll(scriptRegex)) {
    if (m[1]?.trim()) {
      scripts.push(m[1]);
    }
  }

  const noScripts = input.replace(scriptRegex, "");

  return { scripts, deps, noScripts };
}

// DYNAMIC IMPORTS
function extractDynamicImports(input: string, file: string) {
  const deps: string[] = [];

  const regex = /import\(\s*["'](.+?)["']\s*\)/g;

  for (const m of input.matchAll(regex)) {
    const mod = m[1];

    const resolved = mod.startsWith("/")
      ? path.resolve(process.cwd(), "." + mod)
      : path.resolve(path.dirname(file), mod);

    deps.push(resolved);
  }

  return deps;
}

// MAIN
export function parseUniversal(
  content: string,
  file: string
): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  const clean = stripComments(content);

  /* ---------- ASTRO FRONTMATTER ---------- */
  const fm = clean.match(/^---([\s\S]*?)---/);
  if (fm?.[1]) {
    parts.push(fm[1]);
  }

  /* ---------- SCRIPTS ---------- */
  const { scripts, deps: scriptDeps, noScripts } =
    extractScripts(clean, file);

  parts.push(...scripts);
  deps.push(...scriptDeps);

  /* ---------- HANDLERS ---------- */
  parts.push(...extractHTMLHandlers(noScripts));
  parts.push(...extractVueHandlers(noScripts));
  parts.push(...extractSvelteHandlers(noScripts));

  /* ---------- JSX / TEMPLATE ---------- */
  parts.push(...extractBracedExpressions(clean));

  /* ---------- IMPORTS ---------- */
  deps.push(...extractDynamicImports(clean, file));

  return {
    code: [...new Set(parts)].join("\n"),
    deps: [...new Set(deps.filter(Boolean))],
  };
}
