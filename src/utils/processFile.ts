import { detectParser } from "./parsers/router";
import { parseVue } from "./parsers/vue";
import { parseSvelte } from "./parsers/svelte";
import { parseAstro } from "./parsers/astro";

export function processFile(file: string, content: string) {
  const parser = detectParser(file);

  if (parser === "vue") content = parseVue(content);
  if (parser === "svelte") content = parseSvelte(content);
  if (parser === "astro") content = parseAstro(content);

  const virtualFile =
    file.endsWith(".vue") ||
    file.endsWith(".svelte") ||
    file.endsWith(".astro")
      ? file + ".tsx"
      : file;

  return { content, virtualFile };
}
