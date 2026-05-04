import { ParseResult } from "../../types";
import { resolveImport } from "./utils";

export function parseSvelte(content: string, file: string): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  // script
  const scripts = content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g);

  for (const m of scripts) {
    const code = m[1];

    parts.push(code);

    // imports
    const imports = code.matchAll(/import\s+.*?from\s+["'](.+?)["']/g);

    for (const im of imports) {
      const resolved = resolveImport(file, im[1]);
      if (resolved) deps.push(resolved);
    }
  }

  // handlers
  const handlers = content.matchAll(/on:\w+=\{([^}]+)\}/g);

  for (const h of handlers) {
    parts.push(h[1] + ";");
  }

  return {
    code: parts.join("\n"),
    deps,
  };
}
