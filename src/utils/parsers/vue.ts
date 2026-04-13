export function parseVue(
  content: string
) {
  const template =
    content.match(
      /<template[\s\S]*?>([\s\S]*?)<\/template>/
    );

  const script =
    content.match(
      /<script[\s\S]*?>([\s\S]*?)<\/script>/
    );

  return (
    (template?.[1] ?? "") +
    "\n" +
    (script?.[1] ?? "")
  );
}
