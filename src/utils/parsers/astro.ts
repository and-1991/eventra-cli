import path from "path";

export function parseAstro(content: string, file: string) {
  const parts: string[] = [];

  // frontmatter
  const frontmatter = content.match(/^---([\s\S]*?)---/);
  if (frontmatter?.[1]) {
    parts.push(frontmatter[1]);
  }

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
    } else {
      parts.push(body);
    }
  }

  return parts.join("\n");
}
