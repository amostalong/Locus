<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  /**
   * File or directory name to derive an icon for.
   * Directories do not match the extension table; the consumer should branch on isDir instead.
   */
  name: string;
  /** Soften the icon (used for muted rows). */
  dim?: boolean;
}>(), {
  dim: false,
});

interface IconSpec {
  /** Body fill. */
  fill: string;
  /** Optional small symbol drawn on top in white. */
  glyph?: "image" | "data" | "code" | "cube" | "shader";
}

/**
 * Extension → icon spec. Order matters only for tie-breaks (e.g. .prefab.png).
 * The lookup is done via the LAST extension segment, lowercased.
 *
 * Color choice notes:
 *   - Mid-saturation / mid-luminance so colors stay legible on both dark and light backgrounds.
 *   - cs uses VSCode-style green; matches your recent method-color #31CB83 family.
 *   - vue/html/css/json/yaml/etc follow widely-recognized conventions so muscle memory from
 *     other editors still applies.
 */
const EXT_ICON: Record<string, IconSpec> = {
  // Code — C-family / TS / JS / Rust / Go / Kotlin / Java / Lua
  cs:    { fill: "#178600", glyph: "code" },
  ts:    { fill: "#2E7DC4", glyph: "code" },
  tsx:   { fill: "#2E7DC4", glyph: "code" },
  mts:   { fill: "#2E7DC4", glyph: "code" },
  cts:   { fill: "#2E7DC4", glyph: "code" },
  js:    { fill: "#DCC228", glyph: "code" },
  jsx:   { fill: "#DCC228", glyph: "code" },
  mjs:   { fill: "#DCC228", glyph: "code" },
  cjs:   { fill: "#DCC228", glyph: "code" },
  py:    { fill: "#4B8BBE", glyph: "code" },
  rs:    { fill: "#CE422B", glyph: "code" },
  go:    { fill: "#00ADD8", glyph: "code" },
  java:  { fill: "#ED8B00", glyph: "code" },
  kt:    { fill: "#7F52FF", glyph: "code" },
  c:     { fill: "#A8B7C6", glyph: "code" },
  h:     { fill: "#A8B7C6", glyph: "code" },
  cpp:   { fill: "#F34B7D", glyph: "code" },
  cc:    { fill: "#F34B7D", glyph: "code" },
  cxx:   { fill: "#F34B7D", glyph: "code" },
  hpp:   { fill: "#F34B7D", glyph: "code" },
  hxx:   { fill: "#F34B7D", glyph: "code" },
  lua:   { fill: "#3F3F7F", glyph: "code" },
  rb:    { fill: "#9B111E", glyph: "code" },
  php:   { fill: "#777BB4", glyph: "code" },
  swift: { fill: "#F05138", glyph: "code" },
  dart:  { fill: "#03569C", glyph: "code" },

  // Vue / HTML / CSS family
  vue:   { fill: "#41B883" },
  htm:   { fill: "#E44D26" },
  html:  { fill: "#E44D26" },
  css:   { fill: "#C6538C", glyph: "data" },
  scss:  { fill: "#C6538C", glyph: "data" },
  less:  { fill: "#C6538C", glyph: "data" },
  uxml:  { fill: "#C6538C", glyph: "data" },
  uss:   { fill: "#C6538C", glyph: "data" },

  // Data / config — brackets glyph
  json:  { fill: "#FFA500", glyph: "data" },
  jsonc: { fill: "#FFA500", glyph: "data" },
  yaml:  { fill: "#915E91", glyph: "data" },
  yml:   { fill: "#915E91", glyph: "data" },
  toml:  { fill: "#915E91", glyph: "data" },
  xml:   { fill: "#915E91", glyph: "data" },
  xsd:   { fill: "#915E91", glyph: "data" },

  // Docs
  md:        { fill: "#519ABA" },
  markdown:  { fill: "#519ABA" },
  txt:       { fill: "#888888" },

  // Shell / SQL — treat as code
  sh:   { fill: "#4EAA25", glyph: "code" },
  bash: { fill: "#4EAA25", glyph: "code" },
  zsh:  { fill: "#4EAA25", glyph: "code" },
  ps1:  { fill: "#4EAA25", glyph: "code" },
  sql:  { fill: "#E38C00", glyph: "code" },

  // Image — mountain glyph
  png:  { fill: "#C586C0", glyph: "image" },
  jpg:  { fill: "#C586C0", glyph: "image" },
  jpeg: { fill: "#C586C0", glyph: "image" },
  gif:  { fill: "#C586C0", glyph: "image" },
  svg:  { fill: "#C586C0", glyph: "image" },
  webp: { fill: "#C586C0", glyph: "image" },
  bmp:  { fill: "#C586C0", glyph: "image" },
  ico:  { fill: "#C586C0", glyph: "image" },
  tga:  { fill: "#C586C0", glyph: "image" },
  psd:  { fill: "#C586C0", glyph: "image" },

  // Audio
  wav:  { fill: "#EC91C8" },
  mp3:  { fill: "#EC91C8" },
  ogg:  { fill: "#EC91C8" },
  flac: { fill: "#EC91C8" },
  aiff: { fill: "#EC91C8" },

  // Video
  mp4:  { fill: "#FF6D6D" },
  mov:  { fill: "#FF6D6D" },
  avi:  { fill: "#FF6D6D" },
  mkv:  { fill: "#FF6D6D" },
  webm: { fill: "#FF6D6D" },

  // Fonts
  ttf:   { fill: "#B392F0" },
  otf:   { fill: "#B392F0" },
  woff:  { fill: "#B392F0" },
  woff2: { fill: "#B392F0" },

  // Archive
  zip: { fill: "#FFB66B" },
  rar: { fill: "#FFB66B" },
  "7z": { fill: "#FFB66B" },
  tar: { fill: "#FFB66B" },
  gz:  { fill: "#FFB66B" },

  // Unity-specific — cube glyph for assets, distractor colors for shaders
  unity:   { fill: "#6A9F43", glyph: "cube" },
  prefab:  { fill: "#6A9F43", glyph: "cube" },
  asset:   { fill: "#6A9F43", glyph: "cube" },
  mat:     { fill: "#6A9F43", glyph: "cube" },
  controller:          { fill: "#6A9F43", glyph: "cube" },
  overridecontroller:  { fill: "#6A9F43", glyph: "cube" },
  anim:                { fill: "#6A9F43", glyph: "cube" },
  physicsmaterial:     { fill: "#6A9F43", glyph: "cube" },
  physicsmaterial2d:   { fill: "#6A9F43", glyph: "cube" },
  lighting:            { fill: "#6A9F43", glyph: "cube" },
  lightingdataasset:   { fill: "#6A9F43", glyph: "cube" },
  giparams:            { fill: "#6A9F43", glyph: "cube" },
  mixer:               { fill: "#6A9F43", glyph: "cube" },
  preset:              { fill: "#6A9F43", glyph: "cube" },
  playable:            { fill: "#6A9F43", glyph: "cube" },
  signal:              { fill: "#6A9F43", glyph: "cube" },
  spriteatlas:         { fill: "#6A9F43", glyph: "cube" },
  spriteatlasv2:       { fill: "#6A9F43", glyph: "cube" },
  guiskin:             { fill: "#6A9F43", glyph: "cube" },
  fontsettings:        { fill: "#6A9F43", glyph: "cube" },
  flare:               { fill: "#6A9F43", glyph: "cube" },
  cubemap:             { fill: "#6A9F43", glyph: "cube" },
  brush:               { fill: "#6A9F43", glyph: "cube" },
  terrainlayer:        { fill: "#6A9F43", glyph: "cube" },
  scenetemplate:       { fill: "#6A9F43", glyph: "cube" },
  rendertexture:       { fill: "#6A9F43", glyph: "cube" },
  mask:                { fill: "#6A9F43", glyph: "cube" },
  mesh:                { fill: "#6A9F43", glyph: "cube" },

  // Unity shader family — shader-specific glyph
  shader:  { fill: "#C2A03F", glyph: "shader" },
  hlsl:    { fill: "#C2A03F", glyph: "shader" },
  cginc:   { fill: "#C2A03F", glyph: "shader" },
  compute: { fill: "#C2A03F", glyph: "shader" },
  shadergraph: { fill: "#C2A03F", glyph: "shader" },
  vfx:     { fill: "#C2A03F", glyph: "shader" },

  // Unity meta — distinct dim color so .meta doesn't look like content files
  meta:    { fill: "#4D4D4D" },

  // .NET / VS solution files
  csproj: { fill: "#915E91" },
  sln:    { fill: "#915E91" },

  // Unity asmdef / asmref — distinct purple
  asmdef: { fill: "#A074C4" },
  asmref: { fill: "#A074C4" },

  // Git
  gitignore: { fill: "#888888" },
  gitattributes: { fill: "#888888" },
};

const FALLBACK: IconSpec = { fill: "#888888" };

const icon = computed<IconSpec>(() => {
  // Use the LAST extension segment (.prefab.meta is treated as .meta; .asset.meta as .meta)
  const match = /\.([^./\\]+)$/.exec(props.name.toLowerCase());
  if (!match) return FALLBACK;
  return EXT_ICON[match[1]] ?? FALLBACK;
});
</script>

<template>
  <svg
    class="ft-type-icon"
    :class="{ 'is-dim': dim }"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    aria-hidden="true"
  >
    <!-- Body: file shape with corner fold, filled with extension color -->
    <path
      :fill="icon.fill"
      d="M3 1.5A1.5 1.5 0 0 1 4.5 0h5.379a1.5 1.5 0 0 1 1.06.44l2.122 2.12A1.5 1.5 0 0 1 13.5 3.62V14.5A1.5 1.5 0 0 1 12 16H4.5A1.5 1.5 0 0 1 3 14.5v-13z"
    />
    <!-- Subtle corner-fold highlight so the file reads as folded paper -->
    <path
      d="M10 1.5V3.5a.5.5 0 0 0 .5.5h2L10 1.5z"
      fill="white"
      opacity=".22"
    />
    <!-- Glyph: image = mountain + sun -->
    <template v-if="icon.glyph === 'image'">
      <circle cx="7.5" cy="6" r="1.4" fill="white" opacity=".95" />
      <path
        d="M4 12l2.5-3 2 2.2 1.3-1.4L12 12.5z"
        fill="white"
        opacity=".95"
      />
    </template>
    <!-- Glyph: data = curly braces -->
    <template v-else-if="icon.glyph === 'data'">
      <path
        d="M6.4 5.2c-.9 0-1.4.6-1.4 1.5v.8c0 .6-.3.9-.8 1 .5.1.8.4.8 1v.8c0 .9.5 1.5 1.4 1.5M9.6 5.2c.9 0 1.4.6 1.4 1.5v.8c0 .6.3.9.8 1-.5.1-.8.4-.8 1v.8c0 .9-.5 1.5-1.4 1.5"
        fill="none"
        stroke="white"
        stroke-width=".9"
        stroke-linecap="round"
        opacity=".95"
      />
    </template>
    <!-- Glyph: code = angle brackets + slash -->
    <template v-else-if="icon.glyph === 'code'">
      <path
        d="M6 6.2L4.4 8 6 9.8M10 6.2L11.6 8 10 9.8"
        fill="none"
        stroke="white"
        stroke-width="1"
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity=".95"
      />
    </template>
    <!-- Glyph: cube (Unity asset family) -->
    <template v-else-if="icon.glyph === 'cube'">
      <path
        d="M8 4.6L11.4 6.4v3.2L8 11.4 4.6 9.6V6.4z"
        fill="white"
        opacity=".92"
      />
      <path
        d="M8 4.6L11.4 6.4v3.2L8 11.4"
        fill="none"
        stroke="rgba(0,0,0,.35)"
        stroke-width=".5"
      />
    </template>
    <!-- Glyph: shader — triangle/funnel -->
    <template v-else-if="icon.glyph === 'shader'">
      <path
        d="M8 5.4l-2.6 4.4h5.2z"
        fill="white"
        opacity=".92"
      />
    </template>
  </svg>
</template>

<style scoped>
.ft-type-icon {
  display: inline-block;
  vertical-align: -2px;
  flex: 0 0 14px;
}

.ft-type-icon.is-dim {
  opacity: 0.55;
}
</style>
