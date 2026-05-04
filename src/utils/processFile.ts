import path from "path";
import { parseUniversal } from "./universal";

export function processFile(file: string, content: string) {
  const { code, deps } = parseUniversal(content, file);

  const ext = path.extname(file);

  const virtualFile =
    /\.(vue|svelte|astro|html)$/i.test(file)
      ? file.replace(ext, "") + ".tsx"
      : file;

  return {
    content: code || "",
    virtualFile,
    deps: [...new Set(deps.filter(Boolean))],
  };
}
