import { detectParser } from "./parsers/router";

export function processFile(file: string, content: string) {
  const parser = detectParser(file);

  const res = parser(content, file);

  const virtualFile =
    file.endsWith(".vue") ||
    file.endsWith(".svelte") ||
    file.endsWith(".astro")
      ? file + ".tsx"
      : file;

  return {
    content: res.code,
    virtualFile,
    deps: res.deps,
  };
}
