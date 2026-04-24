export function parseVue(content: string) {
  const scriptMatch = content.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/);
  const templateMatch = content.match(/<template>([\s\S]*?)<\/template>/);

  const script = scriptMatch?.[1] ?? "";
  let template = templateMatch?.[1] ?? "";

  template = template.replace(/<!--[\s\S]*?-->/g, "");

  template = template
    .replace(/v-if="[^"]+"/g, "")
    .replace(/v-for="[^"]+"/g, "")
    .replace(/@click=/g, "onClick=");

  const jsx = `
const __VUE_JSX__ = (
  <>
    ${template}
  </>
);
`;

  return script + "\n" + jsx;
}
