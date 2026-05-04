import path from "path";

export function parseVue(content: string, file: string) {
  const parts: string[] = [];

  const scripts = content.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g);

  for (const m of scripts) {
    const attrs = m[1];
    const body = m[2];

    // src
    if (attrs.includes("src")) {
      const src = attrs.match(/src=["'](.+?)["']/)?.[1];
      if (!src) continue;

      const resolved = src.startsWith("/")
        ? path.resolve(process.cwd(), src.slice(1))
        : path.resolve(path.dirname(file), src);

      parts.push(`import "${resolved}"`);
      continue;
    }

    // script setup
    parts.push(body);
  }

  // TEMPLATE
  const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/);
  let template = templateMatch?.[1] ?? "";

  template = template.replace(/<!--[\s\S]*?-->/g, "");

  // @click
  for (const m of template.matchAll(/@[\w-]+="([^"]+)"/g)) {
    parts.push(`${m[1]}();`);
  }

  // v-on
  for (const m of template.matchAll(/v-on:[\w-]+="([^"]+)"/g)) {
    parts.push(`${m[1]}();`);
  }

  return parts.join("\n");
}
