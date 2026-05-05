import { parseUniversal } from "./universal";

export function processFile(file: string, content: string) {
  const parsed = parseUniversal(content, file);

  return {
    content: parsed.code || "",
    deps: [...new Set(parsed.deps.filter(Boolean))],
  };
}
