import { Parser } from "../../types";
import { parseVue } from "./vue";
import { parseSvelte } from "./svelte";
import { parseAstro } from "./astro";

const fallback: Parser = (content) => ({
  code: content,
  deps: [],
});

export function detectParser(file: string): Parser {
  const f = file.toLowerCase();

  if (f.endsWith(".vue")) return parseVue;
  if (f.endsWith(".svelte")) return parseSvelte;
  if (f.endsWith(".astro")) return parseAstro;

  return fallback;
}
