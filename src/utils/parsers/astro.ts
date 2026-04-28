export function parseAstro(content: string) {
  const frontmatter = content.match(/---([\s\S]*?)---/);

  const scripts = [
    ...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)
  ];

  return [
    frontmatter?.[1] ?? "",
    ...scripts.map(s => s[1])
  ].join("\n");
}
