import { parseUniversal } from "./universal";

export function processFile(file: string, content: string) {
  const { code, deps } = parseUniversal(content, file);

  return {
    content: code || "",
    deps: [...new Set(deps.filter(Boolean))],
  };
}
