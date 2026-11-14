// Prism names, which both the viewer (react-syntax-highlighter) and the editor (prismjs) know.
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", json: "json", md: "markdown", mdx: "markdown", css: "css", html: "markup", htm: "markup", xml: "markup",
  svg: "markup", yml: "yaml", yaml: "yaml", py: "python", sh: "bash", bash: "bash", zsh: "bash", swift: "swift",
  kt: "kotlin", kts: "kotlin", java: "java", go: "go", rs: "rust", sql: "sql", toml: "toml", ini: "ini", env: "ini",
  diff: "diff", patch: "diff", cs: "csharp", ps1: "powershell",
};
const BY_NAME: Record<string, string> = { dockerfile: "docker", makefile: "bash", ".env": "ini", ".gitignore": "ini" };
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "svg"]);

function extension(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The highlighting language for a file, or null for plain text. */
export function fileLanguage(name: string): string | null {
  const base = (name.split("/").pop() ?? name).toLowerCase();
  return BY_NAME[base] ?? (base.startsWith(".env") ? "ini" : BY_EXTENSION[extension(name)] ?? null);
}

export const isImageFile = (name: string) => IMAGES.has(extension(name));
export const isMarkdownFile = (name: string) => fileLanguage(name) === "markdown";
