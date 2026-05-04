import fs from "fs";
import path from "path";

export function resolveImport(from: string, src: string): string | null {
  if (!src.startsWith(".")) return null;

  const base = path.resolve(path.dirname(from), src);

  const exts = [".ts", ".tsx", ".js", ".jsx"];

  for (const ext of exts) {
    if (fs.existsSync(base + ext)) return base + ext;
  }

  if (fs.existsSync(base)) return base;

  return null;
}
