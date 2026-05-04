import path from "path";
import { detectParser } from "./parsers/router";

export function processFile(file: string, content: string) {
  const abs = path.resolve(file);

  const parser = detectParser(abs);
  content = parser(content, abs);

  const isVirtual =
    file.endsWith(".vue") ||
    file.endsWith(".svelte") ||
    file.endsWith(".astro");

  const virtualFile = isVirtual ? abs + ".tsx" : abs;

  return { content, virtualFile };
}
