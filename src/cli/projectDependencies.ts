import fg from "fast-glob";
import fs from "fs-extra";
import path from "path";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** Upper bound on workspace members read, so a huge monorepo cannot make `init` crawl. */
const MAX_WORKSPACE_PACKAGES = 300;

type Json = Record<string, unknown>;

/**
 * Parsed package.json, or null when it is missing or not JSON. Whatever else the file holds (an
 * array, a number) is returned as is: every reader below only looks up named properties on it, which
 * is harmless on any JSON value, so there is no point in a second validation here.
 */
async function readPackage(file: string): Promise<Json | null> {
  try {
    return (await fs.readJSON(file)) as Json | null;
  } catch {
    return null;
  }
}

function dependencyNames(pkg: Json): string[] {
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const deps = pkg[field];
    return typeof deps === "object" && deps !== null && !Array.isArray(deps) ? Object.keys(deps) : [];
  });
}

function stringList(value: unknown): string[] {
  // Stryker disable next-line ArrayDeclaration: a stray pattern that matches no directory changes nothing
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** `packages:` entries of a pnpm-workspace.yaml (only the plain list form, which is all pnpm writes). */
function pnpmWorkspacePatterns(yaml: string): string[] {
  // Stryker disable next-line ArrayDeclaration: a stray pattern that matches no directory changes nothing
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages:\s*(#.*)?$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    // YAML lets the dashes sit at the key's own indent (`packages:` / `- 'apps/*'`), so no indent is required.
    const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
    if (item) {
      patterns.push(item[1]);
    } else if (/^\S/.test(line)) {
      // The next top-level key ends the list.
      inPackages = false;
    }
  }
  return patterns;
}

/** A workspace pattern may only point inside the project: no absolute paths, no `..`. */
function staysInsideProject(pattern: string): boolean {
  // Stryker disable next-line StringLiteral: a negated pattern outside the project excludes nothing, so what replaces the "!" cannot show
  const target = pattern.replace(/^!/, "");
  return !path.isAbsolute(target) && !target.split(/[\\/]/).includes("..");
}

/** pnpm-workspace.yaml patterns; an unreadable file (a directory, no permission) counts as having none. */
async function readPnpmPatterns(file: string): Promise<string[]> {
  try {
    return pnpmWorkspacePatterns(await fs.readFile(file, "utf8"));
  } catch {
    // Stryker disable next-line ArrayDeclaration: a stray pattern that matches no directory changes nothing
    return [];
  }
}

async function workspacePatterns(rootDir: string, rootPackage: Json): Promise<string[]> {
  const workspaces = rootPackage.workspaces;
  const fromPackageJson = Array.isArray(workspaces)
    ? stringList(workspaces)
    : stringList((workspaces as Json | undefined)?.packages);
  const fromPnpm = await readPnpmPatterns(path.join(rootDir, "pnpm-workspace.yaml"));
  return [...fromPackageJson, ...fromPnpm].filter(staysInsideProject);
}

/**
 * `apps/*` -> every member's package.json. A negated pattern (`!apps/skipped`) becomes
 * `!apps/skipped/package.json`, which fast-glob treats as an exclusion of exactly those files.
 */
const memberGlob = (pattern: string): string => `${pattern}/package.json`;

/** Member package.json paths for the patterns; a pattern fast-glob rejects (a NUL byte, say) yields none. */
async function findMembers(rootDir: string, patterns: string[]): Promise<string[]> {
  try {
    return await fg(patterns.map(memberGlob), { cwd: rootDir, ignore: ["**/node_modules/**"] });
  } catch {
    // Stryker disable next-line ArrayDeclaration: a stray path that is not a package.json is read as "no package.json"
    return [];
  }
}

/**
 * Every dependency name the project declares: the root package.json plus, in a monorepo
 * (`workspaces` or pnpm-workspace.yaml), each workspace member's package.json.
 */
export async function collectDependencyNames(rootDir: string): Promise<Set<string>> {
  const names = new Set<string>();
  const rootPackage = await readPackage(path.join(rootDir, "package.json"));
  if (rootPackage === null) return names;
  for (const name of dependencyNames(rootPackage)) names.add(name);

  const patterns = await workspacePatterns(rootDir, rootPackage);
  const members = (await findMembers(rootDir, patterns)).slice(0, MAX_WORKSPACE_PACKAGES);
  for (const member of members) {
    const memberPackage = await readPackage(path.join(rootDir, member));
    if (memberPackage !== null) for (const name of dependencyNames(memberPackage)) names.add(name);
  }
  return names;
}
