import path from "path";
import { parseUniversal } from "./universal";

function extractImports(content: string, file: string) {
  return parseUniversal(content, file).deps;
}

export function processFile(file: string, content: string) {
  const ext = path.extname(file);

  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".jsx"
  ) {
    return {
      content,
      deps: extractImports(content, file),
    };
  }

  const parsed = parseUniversal(content, file);

  return {
    content: parsed.code || "",
    deps: [...new Set(parsed.deps.filter(Boolean))],
  };
}
