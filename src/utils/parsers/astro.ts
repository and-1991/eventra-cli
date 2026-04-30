export function parseAstro(content: string) {
  const parts: string[] = [];

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

    if (attrs.includes("src")) {
      const src = attrs.match(/src=["'](.+?)["']/)?.[1];
      if (src) {
        parts.push(`import "${src}"`);
      }
    } else {
      parts.push(body);
    }
  }

  // inline handlers
  const inlineJS = content.matchAll(/on\w+="([^"]+)"/g);

  for (const m of inlineJS) {
    parts.push(m[1] + ";");
  }

  return parts.join("\n");
}
