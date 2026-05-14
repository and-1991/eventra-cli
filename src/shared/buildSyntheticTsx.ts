import {extractTemplateExpressions,} from "./templateExpressionExtractor";

export function buildSyntheticTsx(template: string): string {
  const expressions = extractTemplateExpressions(template);
  const body = expressions.map((expression, index) => {
      return `
const __eventra_expr_${index} =
(() => (${expression}))();
`;
    },
  )
    .join("\n");

  return `
export function __EVENTRA_TEMPLATE__() {
${body}
}
`;
}
