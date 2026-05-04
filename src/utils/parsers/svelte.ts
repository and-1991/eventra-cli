import path from "path";

export function parseSvelte(content: string, file: string) {
  const parts: string[] = [];

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

      parts.push(`import "${resolved}"`);
      continue;
    }

    parts.push(body);
  }

  // handlers
  for (const h of content.matchAll(/on:\w+=\{([^}]+)\}/g)) {
    parts.push(`${h[1]}();`);
  }

  return parts.join("\n");
}
