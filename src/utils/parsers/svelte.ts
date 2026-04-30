export function parseSvelte(content: string) {
  const parts: string[] = [];

  // scripts
  const scripts = content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g);
  for (const m of scripts) {
    parts.push(m[1]);
  }

  // on:click / on:*
  const handlers = content.matchAll(/on:\w+=\{([^}]+)\}/g);
  for (const h of handlers) {
    parts.push(h[1] + ";");
  }

  return parts.join("\n");
}
