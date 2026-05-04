import path from "path";
import { ParseResult } from "../../types";
import { resolveImport } from "./utils";

export function parseAstro(content: string, file: string): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  // frontmatter
  const frontmatter = content.match(/^---([\s\S]*?)---/);
  if (frontmatter?.[1]) {
    parts.push(frontmatter[1]);
  }

  // scripts
  const scripts = content.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g);

  for (const m of scripts) {
    const attrs = m[1];
    const body = m[2];

    // external script
    if (attrs.includes("src")) {
      const src = attrs.match(/src=["'](.+?)["']/)?.[1];
      if (!src) continue;

      let resolved: string;

      if (src.startsWith("/")) {
        resolved = path.join(process.cwd(), src); // FIX
      } else {
        resolved = path.resolve(path.dirname(file), src);
      }

      deps.push(resolved);
      continue;
    }

    parts.push(body);

    const imports = body.matchAll(/import\s+.*?from\s+["'](.+?)["']/g);

    for (const im of imports) {
      const resolved = resolveImport(file, im[1]);
      if (resolved) deps.push(resolved);
    }
  }

  return {
    code: parts.join("\n"),
    deps,
  };
}
