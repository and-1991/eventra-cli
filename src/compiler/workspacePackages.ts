import fg from "fast-glob";
import fs from "fs";
import path from "path";

import {
  MAX_WORKSPACE_PACKAGES,
  memberGlob,
  pnpmWorkspacePatterns,
  staysInsideProject,
  stringList,
} from "../cli/projectDependencies";

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/**
 * The packages of a monorepo (`workspaces` in package.json, or pnpm-workspace.yaml) by name, mapped to
 * their folder. `import "@acme/lib/hooks/x"` then resolves to a folder of the repo itself, so a project
 * whose dependencies are not installed still links its own packages together.
 */
export function findWorkspacePackages(rootDir: string): ReadonlyMap<string, string> {
  const packages = new Map<string, string>();
  const rootPackage = readJson(path.join(rootDir, "package.json"));
  if (!rootPackage) return packages;

  const workspaces = rootPackage.workspaces;
  const fromPackageJson = Array.isArray(workspaces)
    ? stringList(workspaces)
    : stringList((workspaces as Record<string, unknown> | undefined)?.packages);
  let fromPnpm: string[] = [];
  try {
    fromPnpm = pnpmWorkspacePatterns(fs.readFileSync(path.join(rootDir, "pnpm-workspace.yaml"), "utf8"));
  } catch {
    // no pnpm-workspace.yaml (or an unreadable one): the package.json patterns are all there is
  }
  const patterns = [...fromPackageJson, ...fromPnpm].filter(staysInsideProject);
  if (patterns.length === 0) return packages;

  let members: string[];
  try {
    members = fg.sync(patterns.map(memberGlob), { cwd: rootDir, ignore: ["**/node_modules/**"] });
  } catch {
    // a pattern fast-glob rejects: no members
    return packages;
  }
  for (const member of members.slice(0, MAX_WORKSPACE_PACKAGES)) {
    const name = readJson(path.join(rootDir, member))?.name;
    if (typeof name === "string" && name !== "" && !packages.has(name)) {
      packages.set(name, path.dirname(path.join(rootDir, member)));
    }
  }
  return packages;
}
