import ts from "typescript";

import type { TrackedArgument } from "../../analysis/shared/propagation";
import { unwrapExpression } from "../../analysis/shared/utils";
import type { SinkRuleConfig } from "../../types";
import type { PluginRegistry } from "../registry";
import type { SinkDetector } from "../types";
import { SINK_PRESETS, type ResolvedSinkRule } from "./sinkPresets";

export type { ResolvedSinkRule } from "./sinkPresets";

/** Expands presets and drops malformed rules. `warn` receives a message per dropped rule. */
export function resolveSinkRules(
  rules: readonly SinkRuleConfig[],
  warn: (message: string) => void,
): ResolvedSinkRule[] {
  const resolved: ResolvedSinkRule[] = [];
  for (const rule of rules) {
    if (rule.preset !== undefined) {
      const preset = typeof rule.preset === "string" && Object.hasOwn(SINK_PRESETS, rule.preset) ? SINK_PRESETS[rule.preset] : undefined;
      if (!preset) {
        warn(
          `Eventra: unknown sinks preset "${rule.preset}" (available: ${Object.keys(SINK_PRESETS).join(", ")}) - skipped.`,
        );
        continue;
      }
      resolved.push(...preset);
      continue;
    }
    // eventra.json is hand-edited JSON: every field can hold any type, and a wrong one must be skipped, not crash.
    const callee = typeof rule.callee === "string" ? rule.callee.trim() : undefined;
    if (!callee || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(callee)) {
      warn(`Eventra: sinks rule needs a "preset" or a dotted "callee" like "analytics.track" - skipped.`);
      continue;
    }
    const nameArg = rule.nameArg ?? 0;
    if (!Number.isInteger(nameArg) || nameArg < 0) {
      warn(`Eventra: sinks rule "${callee}" has an invalid "nameArg" - skipped.`);
      continue;
    }
    if (rule.nameProperty !== undefined && typeof rule.nameProperty !== "string") {
      warn(`Eventra: sinks rule "${callee}" has an invalid "nameProperty" - skipped.`);
      continue;
    }
    if (
      rule.modules !== undefined &&
      (!Array.isArray(rule.modules) || !rule.modules.every((m) => typeof m === "string" && m !== ""))
    ) {
      warn(`Eventra: sinks rule "${callee}" has an invalid "modules" - skipped.`);
      continue;
    }
    let when: ResolvedSinkRule["when"];
    if (rule.when !== undefined) {
      const candidate = rule.when as Partial<NonNullable<SinkRuleConfig["when"]>> | null;
      if (
        !candidate ||
        !Number.isInteger(candidate.arg) ||
        candidate.arg! < 0 ||
        typeof candidate.equals !== "string" ||
        candidate.equals === ""
      ) {
        warn(`Eventra: sinks rule "${callee}" has an invalid "when" - skipped.`);
        continue;
      }
      when = { arg: candidate.arg!, equals: candidate.equals };
    }
    resolved.push({
      callee,
      nameArg,
      ...(rule.nameProperty ? { nameProperty: rule.nameProperty } : {}),
      ...(rule.modules?.length ? { modules: rule.modules } : {}),
      ...(when ? { when } : {}),
    });
  }
  return resolved;
}

/** `a.b.c` / `this.a.b` / `a?.b` -> "a.b.c"; null for anything that isn't a plain property path. */
function calleePath(expr: ts.Expression): string | null {
  const e = unwrapExpression(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(e)) {
    const head = calleePath(e.expression);
    return head === null ? null : `${head}.${e.name.text}`;
  }
  return null;
}

function moduleMatches(specifier: string, modules: readonly string[]): boolean {
  return modules.some((m) => specifier === m || specifier.startsWith(`${m}/`));
}

const MAX_ALIAS_HOPS = 6;

/**
 * The symbol an identifier refers to, keeping an import as the import binding itself. TS resolves an
 * import all the way to its target in some positions once something makes the module resolvable
 * (a wildcard `declare module "*"` does that for every unresolved package), and the trail to the
 * package's name is gone by then.
 */
function symbolAt(id: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(id);
  // Stryker disable next-line ConditionalExpression: fast path only; the scope lookup below returns the same alias
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) return symbol;
  return checker.getSymbolsInScope(id, ts.SymbolFlags.Alias).find((alias) => alias.name === id.text) ?? symbol;
}

/** `import("m")`: the specifier of the call decides, no installed package needed. */
function dynamicImportFrom(expression: ts.Expression, modules: readonly string[]): boolean {
  const specifier = ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.ImportKeyword
    ? expression.arguments[0]
    : undefined;
  return specifier !== undefined && ts.isStringLiteralLike(specifier) && moduleMatches(specifier.text, modules);
}

const PROMISE_TYPES = new Set(["Promise", "PromiseLike"]);

/**
 * True when a type annotation names something from `modules`: `PostHog`, `PostHog | null`, `ph.PostHog`,
 * `typeof import("posthog-js")`, `Promise<typeof import("posthog-js")>`, `typeof posthog`.
 */
function typeFromModules(type: ts.TypeNode, checker: ts.TypeChecker, modules: readonly string[], hops: number): boolean {
  if (ts.isParenthesizedTypeNode(type)) return typeFromModules(type.type, checker, modules, hops);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some((member) => typeFromModules(member, checker, modules, hops));
  }
  if (ts.isImportTypeNode(type)) {
    return ts.isLiteralTypeNode(type.argument) && ts.isStringLiteral(type.argument.literal) && moduleMatches(type.argument.literal.text, modules);
  }
  const name = ts.isTypeReferenceNode(type) ? type.typeName : ts.isTypeQueryNode(type) ? type.exprName : undefined;
  if (name === undefined) return false;
  let root: ts.EntityName = name;
  while (ts.isQualifiedName(root)) root = root.left;
  return (
    symbolFromModules(symbolAt(root, checker), checker, modules, hops + 1) ||
    // a promise of the module (`Promise<typeof import("posthog-js")>`), not any generic that mentions it
    (ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      PROMISE_TYPES.has(type.typeName.text) &&
      (type.typeArguments ?? []).some((argument) => typeFromModules(argument, checker, modules, hops)))
  );
}

/** `return expr` statements of a function body, not looking into functions nested in it. */
function returnedExpressions(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) return [body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/** The symbol `name` exported by the module a specifier points at, when TS can resolve that module. */
function resolveExport(specifier: ts.Expression, name: string, checker: ts.TypeChecker): ts.Symbol | undefined {
  const moduleSymbol = checker.getSymbolAtLocation(specifier);
  return moduleSymbol ? checker.tryGetMemberInModuleExports(name, moduleSymbol) : undefined;
}

/**
 * `usePostHog()`, `new PostHog(k)`, `await init()`, `this.client`, `this.getClient()`,
 * `AnalyticsBrowser.load()` or a bare alias `usePostHog`: true when the name at the heart of the
 * expression, or the import its chain hangs off, originates from `modules`.
 */
function expressionFromModules(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  modules: readonly string[],
  hops: number,
): boolean {
  let expr = unwrapExpression(expression);
  if (ts.isAwaitExpression(expr)) expr = unwrapExpression(expr.expression);
  if (dynamicImportFrom(expr, modules)) return true;
  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) expr = unwrapExpression(expr.expression);
  const fromName = (name: ts.Node): boolean =>
    ts.isIdentifier(name) && symbolFromModules(symbolAt(name, checker), checker, modules, hops);
  if (!ts.isPropertyAccessExpression(expr)) return fromName(expr);
  // `this.client` is vetted through the property's own declaration; `AnalyticsBrowser.load()` and
  // `amplitude.getInstance()` hang off an import, so the chain's root decides.
  let root: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(root)) root = unwrapExpression(root.expression);
  // `(await import("posthog-js")).default`
  if (ts.isAwaitExpression(root)) root = unwrapExpression(root.expression);
  return fromName(expr.name) || fromName(root) || dynamicImportFrom(root, modules);
}

function declarationFromModules(
  decl: ts.Declaration,
  checker: ts.TypeChecker,
  modules: readonly string[],
  hops: number,
): boolean {
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
    // Every import binding sits under an ImportDeclaration, whose specifier is a string literal.
    const importDecl = ts.findAncestor(decl, ts.isImportDeclaration)!;
    if (moduleMatches((importDecl.moduleSpecifier as ts.StringLiteral).text, modules)) return true;
    if (ts.isNamespaceImport(decl)) return false;
    const exported = ts.isImportSpecifier(decl) ? (decl.propertyName ?? decl.name).text : "default";
    return symbolFromModules(resolveExport(importDecl.moduleSpecifier, exported, checker), checker, modules, hops + 1);
  }

  if (ts.isExportSpecifier(decl)) {
    const specifier = decl.parent.parent.moduleSpecifier;
    if (!specifier) {
      // export { local as alias }
      return symbolFromModules(checker.getExportSpecifierLocalTargetSymbol(decl), checker, modules, hops + 1);
    }
    // export { name as alias } from "module"
    if (moduleMatches((specifier as ts.StringLiteral).text, modules)) return true;
    const exported = (decl.propertyName ?? decl.name).text;
    return symbolFromModules(resolveExport(specifier, exported, checker), checker, modules, hops + 1);
  }

  // export default client
  if (ts.isExportAssignment(decl)) {
    return expressionFromModules(decl.expression, checker, modules, hops + 1);
  }

  // function useAnalytics() { return usePostHog() } / const load = () => import("posthog-js"): a function
  // gives back what it returns (or what its return annotation names)
  const fn = ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)
    ? decl
    : (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) &&
        decl.initializer &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
      ? decl.initializer
      : undefined;
  if (fn) {
    if (fn.type && typeFromModules(fn.type, checker, modules, hops)) return true;
    if (fn.body && returnedExpressions(fn.body).some((returned) => expressionFromModules(returned, checker, modules, hops + 1))) {
      return true;
    }
  }

  // const { posthog } = usePostHog(): the binding's own declaration is the enclosing variable.
  const owner = ts.isBindingElement(decl) ? decl.parent.parent : decl;

  // promise.then(({ default: posthog }) => ...) / promise.then((mod) => ...): the parameter holds what the promise resolves to
  if (ts.isParameter(owner)) {
    const callback = owner.parent;
    const call = callback.parent;
    if (
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      ts.isCallExpression(call) &&
      call.arguments[0] === callback &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "then"
    ) {
      return expressionFromModules(call.expression.expression, checker, modules, hops + 1);
    }
  }
  // Variables, properties, parameters, functions (return type) and type aliases all keep their
  // annotation in `type`; variables, properties and parameters keep a default/initial value in
  // `initializer`. Anything else (classes, interfaces, ...) simply has neither.
  const { type, initializer } = owner as { type?: ts.TypeNode; initializer?: ts.Expression };
  // let client: PostHog | null / private client: PostHog / (client: PostHog) => ... / type Client = PostHog
  if (type && typeFromModules(type, checker, modules, hops)) {
    return true;
  }
  // const ph = usePostHog() / new PostHog(k) / client = new PostHog(k) / const useTrack = usePostHog
  return initializer !== undefined && expressionFromModules(initializer, checker, modules, hops + 1);
}

/**
 * True when `symbol` originates from one of `modules`, following import/re-export chains
 * (`import { useAnalytics } from "@/hooks"` -> `export { usePostHog as useAnalytics } from "posthog-js/react"`).
 * Works without installed dependencies, by reading the specifiers along the chain.
 */
function symbolFromModules(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  modules: readonly string[],
  hops = 0,
): boolean {
  if (!symbol || hops > MAX_ALIAS_HOPS) return false;
  // A real ts.Symbol's `declarations` is only undefined for synthetic symbols we never see here.
  // Stryker disable next-line ArrayDeclaration: unreachable fallback, see above
  /* v8 ignore next */
  const declarations = symbol.declarations ?? [];
  return declarations.some((decl) => declarationFromModules(decl, checker, modules, hops));
}

/** `rule.when`: the guard argument must be the exact string literal (`gtag("event", ...)` but not `gtag("config", ...)`). */
function whenSatisfied(call: ts.CallExpression, rule: ResolvedSinkRule): boolean {
  if (!rule.when) return true;
  const guard = call.arguments[rule.when.arg];
  const literal = guard && unwrapExpression(guard);
  return literal !== undefined && ts.isStringLiteralLike(literal) && literal.text === rule.when.equals;
}

function trackedArgumentFor(call: ts.CallExpression, rule: ResolvedSinkRule): TrackedArgument | null {
  const arg = call.arguments[rule.nameArg];
  if (!arg) return null;
  const literal = unwrapExpression(arg);
  if (ts.isObjectLiteralExpression(literal)) {
    // Only `{ event: name }` is a usable shape; the scanner reads this property off the literal.
    // (`SpreadAssignment` has no name, hence the kind check.)
    const found = literal.properties.some(
      (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === rule.nameProperty,
    );
    return found ? { index: rule.nameArg, propertyPath: [rule.nameProperty!] } : null;
  }
  // Stryker disable next-line ArrayDeclaration: propertyPath is only read for object-literal arguments
  return { index: rule.nameArg, propertyPath: [] };
}

export function createConfiguredSinkDetector(rules: readonly ResolvedSinkRule[]): SinkDetector {
  return {
    name: "configured-sinks",
    detect({ call, checker }) {
      const callee = unwrapExpression(call.expression);
      // `gtag(...)` / `x.capture(...)`: the name actually being called.
      const last = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const path = calleePath(callee);

      for (const rule of rules) {
        // A dotted rule needs the whole plain path (`foo().analytics.track` has none); a bare name
        // matches whatever receiver it hangs off, including a call (`usePostHog().capture`).
        const matched = rule.callee.includes(".")
          ? path !== null && (path === rule.callee || path.endsWith(`.${rule.callee}`))
          : last === rule.callee;
        if (!matched || !whenSatisfied(call, rule)) continue;
        // A bare name is too generic to match alone: a receiver-vetted rule checks where the receiver
        // (`x` in `x.capture(...)`) or, for a bare call, the called name itself comes from.
        if (
          rule.modules &&
          !expressionFromModules(ts.isPropertyAccessExpression(callee) ? callee.expression : callee, checker, rule.modules, 0)
        ) {
          continue;
        }
        const tracked = trackedArgumentFor(call, rule);
        if (tracked) return { call, trackedArguments: [tracked] };
      }
      return null;
    },
  };
}

/** Registers the `sinks` rules from eventra.json (declarative data only - never code). */
export function registerConfiguredSinks(
  registry: PluginRegistry,
  rules: readonly SinkRuleConfig[] | undefined,
  warn: (message: string) => void = (m) => console.warn(m),
): void {
  if (!rules?.length) return;
  const resolved = resolveSinkRules(rules, warn);
  if (resolved.length === 0) return;
  registry.registerSinkDetector(createConfiguredSinkDetector(resolved));
}
