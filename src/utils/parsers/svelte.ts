import { ParseResult } from "../../types";

export function parseSvelte(content: string): ParseResult {
  const parts: string[] = [];
  const deps: string[] = [];

  // script
  const scripts = content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g);
  for (const m of scripts) {
    parts.push(m[1]);
  }

  // on:click={...}
  const handlers = content.matchAll(/on:\w+=\{([^}]+)\}/g);

  for (const h of handlers) {
    parts.push(h[1] + ";");
  }

  return {
    code: parts.join("\n"),
    deps,
  };
}
