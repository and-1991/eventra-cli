export function getVirtualFile(file: string) {
  return /\.(vue|svelte|astro|html)$/i.test(file)
    ? file + ".tsx"
    : file;
}
