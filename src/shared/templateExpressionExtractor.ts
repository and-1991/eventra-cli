export function extractTemplateExpressions(template: string,): string[] {
  const expressions: string[] = [];
  // Vue
  const vue = /[:@]?[a-zA-Z0-9_-]+\s*=\s*"([^"]+)"/g;
  for (const match of template.matchAll(vue)) {
    expressions.push(match[1]);
  }
  // Svelte
  const svelte = /\{([^}]+)\}/g;
  for (const match of template.matchAll(svelte)) {
    expressions.push(match[1]);
  }
  // Astro
  const astro = /\{([^}]+)\}/g;
  for (const match of template.matchAll(astro)) {
    expressions.push(match[1],);
  }
  return expressions;
}
