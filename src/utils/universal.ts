import path from "path";
import { ParseResult } from "../types";

/* ---------------------------------- */
/* COMMENT STRIP (SAFE)               */
/* ---------------------------------- */
function stripComments(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/* ---------------------------------- */
/* TRACK DETECTOR                     */
/* ---------------------------------- */
function looksLikeTracking(code: string) {
  return /\btrack\s*\(|\.track\s*\(/.test(code);
}

/* ---------------------------------- */
/* SAFE {} PARSER (JSX / TEMPLATES)   */
/* ---------------------------------- */
function extractBracedExpressions(input: string): string[] {
  const result: string[] = [];

  let depth = 0;
  let start = -1;
  let inString: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    // handle strings
    if (inString) {
      if (char === inString && input[i - 1] !== "\\") {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

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

/* ---------------------------------- */
/* HTML HANDLERS                      */
/* ---------------------------------- */
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

/* ---------------------------------- */
/* VUE HANDLERS                       */
/* ---------------------------------- */
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

/* ---------------------------------- */
/* SVELTE HANDLERS                    */
/* ---------------------------------- */
function extractSvelteHandlers(input: string): string[] {
  const result: string[] = [];

  const regex = /\bon:[\w]+\s*=\s*{([\s\S]*?)}/g;

  for (const m of input.matchAll(regex)) {
    const expr = m[1];

    const nested = extractBracedExpressions(`{${expr}}`);
    result.push(...nested);
  }

  return result;
}

/* ---------------------------------- */
/* SCRIPT EXTRACTION                  */
/* ---------------------------------- */
function extractScripts(input: string, file: string) {
  const scripts: string[] = [];
  const deps: string[] = [];

  // <script src="">
  const srcRegex =
    /<script\b[^>]*?\bsrc=["'](.+?)["'][^>]*>/gi;

  for (const m of input.matchAll(srcRegex)) {
    const src = m[1];

    const resolved = src.startsWith("/")
      ? path.resolve(process.cwd(), "." + src)
      : path.resolve(path.dirname(file), src);

    deps.push(resolved);
  }

  // inline <script>
  const scriptRegex =
    /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

  for (const m of input.matchAll(scriptRegex)) {
    if (m[1]?.trim()) {
      scripts.push(m[1]);
    }
  }

  const noScripts = input.replace(scriptRegex, "");

  return { scripts, deps, noScripts };
}

/* ---------------------------------- */
/* STATIC IMPORTS                     */
/* ---------------------------------- */
function extractStaticImports(input: string, file: string) {
  const deps: string[] = [];

  const regex =
    /import\s+(?:.+?\s+from\s+)?["'](.+?)["']/g;

  for (const m of input.matchAll(regex)) {
    const mod = m[1];

    if (!mod.startsWith(".") && !mod.startsWith("/")) continue;

    const resolved = path.resolve(
      path.dirname(file),
      mod
    );

    deps.push(resolved);
  }

  return deps;
}

/* ---------------------------------- */
/* DYNAMIC IMPORTS                    */
/* ---------------------------------- */
function extractDynamicImports(input: string, file: string) {
  const deps: string[] = [];
  const calls: string[] = [];

  const regex = /import\(\s*["'](.+?)["']\s*\)/g;

  for (const m of input.matchAll(regex)) {
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

/* ---------------------------------- */
/* MAIN                               */
/* ---------------------------------- */
export function parseUniversal(
  content: string,
  file: string
): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  const clean = stripComments(content);

  /* ---------- ASTRO FRONTMATTER ---------- */
  const fm = clean.match(/^\s*---([\s\S]*?)---/);
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
  deps.push(...extractStaticImports(clean, file));

  const dyn = extractDynamicImports(clean, file);
  deps.push(...dyn.deps);
  parts.push(...dyn.calls);

  return {
    code: parts.length ? parts.join("\n") : content,
    deps: [...new Set(deps.filter(Boolean))],
  };
}
