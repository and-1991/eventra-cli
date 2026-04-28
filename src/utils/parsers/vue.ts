export function parseVue(content: string) {
  const scriptMatches = [
    ...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)
  ];

  const script = scriptMatches.map(m => m[1]).join("\n");

  // template
  const templateMatch = content.match(/<template>([\s\S]*?)<\/template>/);
  let template = templateMatch?.[1] ?? "";

  template = template.replace(/<!--[\s\S]*?-->/g, "");

  // Vue → JSX
  template = template
    .replace(/\bclass=/g, "className=")
    .replace(/\bfor=/g, "htmlFor=")
    .replace(/@(\w+)=/g, (_, e) => {
      const name = e.charAt(0).toUpperCase() + e.slice(1);
      return `on${name}=`;
    })
    .replace(/v-if="[^"]+"/g, "")
    .replace(/v-for="[^"]+"/g, "");

  const jsx = `
const __VUE_JSX__ = (
  <>
    ${template}
  </>
);
`;

  return script + "\n" + jsx;
}
