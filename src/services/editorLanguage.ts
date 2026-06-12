const EXT_TO_LANGUAGE: Record<string, string> = {
  // ── General code ─────────────────────────────────────────────────────────
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  vue: "html",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  xml: "xml",
  xsd: "xml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  sql: "sql",
  rb: "ruby",
  php: "php",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  txt: "plaintext",

  // ── Unity scripting ──────────────────────────────────────────────────────
  // .cs already handled above as csharp.

  // ── Unity assets / serialized YAML ───────────────────────────────────────
  // Unity stores most assets as YAML when "Asset Serialization" is set to
  // "Force Text" (the default for source-controlled projects).
  unity: "yaml",
  prefab: "yaml",
  asset: "yaml",
  mat: "yaml",
  meta: "yaml",
  controller: "yaml",
  overridecontroller: "yaml",
  anim: "yaml",
  physicsmaterial: "yaml",
  physicsmaterial2d: "yaml",
  lighting: "yaml",
  lightingdataasset: "yaml",
  giparams: "yaml",
  mixer: "yaml",
  preset: "yaml",
  playable: "yaml",
  signal: "yaml",
  spriteatlas: "yaml",
  spriteatlasv2: "yaml",
  guiskin: "yaml",
  fontsettings: "yaml",
  flare: "yaml",
  cubemap: "yaml",
  brush: "yaml",
  terrainlayer: "yaml",
  scenetemplate: "yaml",
  rendertexture: "yaml",
  mask: "yaml",
  mesh: "yaml",

  // ── Unity asmdef / package metadata ──────────────────────────────────────
  asmdef: "json",
  asmref: "json",
  shadergraph: "json", // Shader Graph saves as JSON.
  vfx: "json",         // Visual Effect Graph saves as JSON.

  // ── Unity UI Toolkit ─────────────────────────────────────────────────────
  uxml: "xml",
  uss: "css",

  // ── Unity shaders ────────────────────────────────────────────────────────
  shader: "shaderlab",
  hlsl: "hlsl",
  cginc: "hlsl",
  compute: "hlsl",
};

export function languageFromPath(path: string): string {
  const match = /\.([^./\\]+)$/.exec(path);
  if (!match) return "plaintext";
  return EXT_TO_LANGUAGE[match[1].toLowerCase()] ?? "plaintext";
}
