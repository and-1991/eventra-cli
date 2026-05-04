import path from "path";
import { ParseResult } from "../../types";

export function parseVue(content: string, file: string): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  // SCRIPT
  const scripts = content.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g);

  for (const m of scripts) {
    const attrs = m[1];
    const body = m[2];

    if (attrs.includes("src")) {
      const src = attrs.match(/src=["'](.+?)["']/)?.[1];
      if (!src) continue;

      const resolved = src.startsWith("/")
        ? path.resolve(process.cwd(), src.slice(1))
        : path.resolve(path.dirname(file), src);

      deps.push(resolved);
      continue;
    }

    parts.push(body);
  }

  // TEMPLATE
  const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/);
  let template = templateMatch?.[1] ?? "";

  template = template.replace(/<!--[\s\S]*?-->/g, "");

  // @click
  const handlers = template.matchAll(/@[\w-]+="([^"]+)"/g);
  for (const h of handlers) {
    parts.push(h[1] + ";");
  }

  // v-on
  const vOn = template.matchAll(/v-on:[\w-]+="([^"]+)"/g);
  for (const v of vOn) {
    parts.push(v[1] + ";");
  }

  // :prop
  const binds = template.matchAll(/:[\w-]+="([^"]+)"/g);
  for (const b of binds) {
    parts.push(b[1] + ";");
  }

  return {
    code: parts.join("\n"),
    deps,
  };
}
