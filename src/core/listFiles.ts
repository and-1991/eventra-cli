import fg from "fast-glob";
import fs from "fs/promises";

/**
 * The files that match `patterns` and are not in `ignore`, as absolute paths. Symbolic links to folders are not
 * followed (two links back to a parent made the walk endless, and the folder is scanned under its real path anyway),
 * but a symbolic link to a file is a file: fast-glob alone drops those when it does not follow links.
 */
export async function listFiles(patterns: string[], ignore: string[]): Promise<string[]> {
  const entries = await fg(patterns, { ignore, absolute: true, followSymbolicLinks: false, onlyFiles: false, objectMode: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.dirent.isFile()) {
      files.push(entry.path);
    } else if (entry.dirent.isSymbolicLink()) {
      try {
        if ((await fs.stat(entry.path)).isFile()) files.push(entry.path);
      } catch {
        // a link to nothing is not a file
      }
    }
  }
  return files;
}
