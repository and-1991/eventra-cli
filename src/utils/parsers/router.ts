export function detectParser(file: string) {
  file = file.toLowerCase();

  if (file.endsWith(".vue")) return "vue";
  if (file.endsWith(".svelte")) return "svelte";
  if (file.endsWith(".astro")) return "astro";

  return "ts";
}
