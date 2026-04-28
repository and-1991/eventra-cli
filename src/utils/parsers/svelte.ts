export function parseSvelte(content: string) {
  const scriptMatches = [
    ...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)
  ];

  return scriptMatches.map(m => m[1]).join("\n");
}
