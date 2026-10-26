import ts from "typescript";

export type WrapperCallSite = ts.CallExpression | ts.JsxOpeningElement | ts.JsxSelfClosingElement;

/**
 * A JSX element is a call of its component with one argument: the props object. Rebuilt here as an
 * object literal from the attributes so the existing call-site machinery (`resolveObjectPath`,
 * parameter bindings) works unchanged. Spread attributes and children are ignored, and each
 * attribute value is the original AST node, so symbol resolution still sees real code.
 */
export function jsxPropsAsObjectLiteral(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ts.ObjectLiteralExpression {
  const properties: ts.PropertyAssignment[] = [];
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name) || !attribute.initializer) {
      continue;
    }
    const value = ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer;
    if (value && !ts.isJsxElement(value) && !ts.isJsxSelfClosingElement(value) && !ts.isJsxFragment(value)) {
      properties.push(ts.factory.createPropertyAssignment(attribute.name, value));
    }
  }
  return ts.factory.createObjectLiteralExpression(properties);
}

/** The expression naming the called function/component; null for `<ns:tag>`, which is never a component. */
export function callSiteExpression(site: WrapperCallSite): ts.Expression | null {
  if (ts.isCallExpression(site)) {
    return site.expression;
  }
  return ts.isJsxNamespacedName(site.tagName) ? null : site.tagName;
}

/** The argument at `index`; for a JSX site only index 0 exists, and it is the props object. */
export function callSiteArgument(site: WrapperCallSite, index: number): ts.Expression | undefined {
  return ts.isCallExpression(site) ? site.arguments[index] : index === 0 ? jsxPropsAsObjectLiteral(site) : undefined;
}
