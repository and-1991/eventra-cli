import path from "path";

export function isExternalFile(file: string) {
  const normalized = path.resolve(file);

  return (
    normalized.includes(`${path.sep}node_modules${path.sep}`) ||
    normalized.includes(`${path.sep}dist${path.sep}`) ||
    normalized.includes(`${path.sep}build${path.sep}`) ||
    normalized.endsWith(".d.ts")
  );
}
