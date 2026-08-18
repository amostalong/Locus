import path from "node:path";
import { defineConfig, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteStaticCopy } from "vite-plugin-static-copy";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const devPort = Number(process.env.LOCUS_DEV_PORT ?? 14901);
// @ts-expect-error process is a nodejs global
const devHmrPort = Number(process.env.LOCUS_DEV_HMR_PORT ?? 1421);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  worker: {
    format: "es",
  },
  plugins: [
    vue(),
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(path.resolve(import.meta.dirname, "node_modules/vditor/dist/**/*")),
          dest: "vendor/vditor",
          rename: {
            stripBase: 2,
          },
        },
      ],
    }),
  ],

  resolve: {
    alias: [
      {
        find: /^vue$/,
        replacement: "vue/dist/vue.esm-bundler.js",
      },
    ],
  },

  test: {
    setupFiles: ["src/__tests__/setupVitest.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["ref/**"],
  },

  build: {
    // Locus ships exclusively on WebView2 (Chromium); top-level await in
    // src/i18n.ts (async locale catalogs) needs a post-es2020 target.
    target: "chrome105",
    chunkSizeWarningLimit: 800, // three.js chunk ~725KB, already lazy-loaded
    rollupOptions: {
      input: {
        // Main app entry plus the lightweight sub-window entry; sub-windows
        // (plan review, diff review, View hosts, ...) skip the main store
        // and service graph entirely.
        main: path.resolve(import.meta.dirname, "index.html"),
        window: path.resolve(import.meta.dirname, "window.html"),
      },
      output: {
        manualChunks(id) {
          const normalizedId = normalizePath(id);
          if (normalizedId.includes("/node_modules/three/")) return "three-preview";
          if (normalizedId.includes("/node_modules/ag-psd/")) return "binary-preview";
          if (
            normalizedId.includes("/node_modules/monaco-editor/")
            || normalizedId.includes("/node_modules/@codingame/")
            || normalizedId.includes("/node_modules/monaco-languageclient")
            || normalizedId.includes("/node_modules/vscode-languageclient")
            || normalizedId.includes("/node_modules/vscode-languageserver-protocol")
            || normalizedId.includes("/node_modules/vscode-jsonrpc")
          ) return "monaco";
          if (
            normalizedId.includes("/node_modules/vue/")
            || normalizedId.includes("/node_modules/@vue/")
            || normalizedId.includes("/node_modules/pinia/")
            || normalizedId.includes("/node_modules/marked/")
            || normalizedId.includes("/node_modules/highlight.js/")
          ) return "vendor";
          return undefined;
        },
      },
    },
  },

  // monaco-vscode-api packages register extension assets via
  // `new URL('./resources/...', import.meta.url)`. Vite's dep pre-bundler
  // moves the JS into `.vite/deps/` but does NOT copy the referenced
  // resources, so those URLs 404 in dev (the Tauri dev server then serves
  // index.html as fallback, which the WASM/JSON loaders then choke on
  // — "expected magic word 00 61 73 6d, found 3c 21 64 6f"). Excluding
  // the packages disables pre-bundling and keeps the resource URLs valid.
  optimizeDeps: {
    // ESM packages that ship resource files referenced via
    // `import.meta.url`. Pre-bundling rewrites those URLs into `.vite/deps/`
    // but the resources don't get copied, so we keep the original
    // resolution for these.
    exclude: [
      "monaco-editor",
      "monaco-languageclient",
      "vscode",
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-editor-api",
      "@codingame/monaco-vscode-extension-api",
      "@codingame/monaco-vscode-configuration-service-override",
      "@codingame/monaco-vscode-csharp-default-extension",
      "@codingame/monaco-vscode-editor-service-override",
      "@codingame/monaco-vscode-extensions-service-override",
      "@codingame/monaco-vscode-files-service-override",
      "@codingame/monaco-vscode-languages-service-override",
      "@codingame/monaco-vscode-model-service-override",
      "@codingame/monaco-vscode-monarch-service-override",
      "@codingame/monaco-vscode-textmate-service-override",
      "@codingame/monaco-vscode-theme-defaults-default-extension",
      "@codingame/monaco-vscode-theme-service-override",
    ],
    // CJS packages must be pre-bundled so the browser sees real ESM
    // named exports (BaseLanguageClient, AbstractMessageReader, etc.)
    // instead of `module.exports`.
    include: [
      "vscode-jsonrpc",
      "vscode-jsonrpc/browser.js",
      "vscode-languageclient",
      "vscode-languageclient/browser.js",
      "vscode-languageserver-protocol",
      "vscode-languageserver-protocol/browser",
    ],
    esbuildOptions: {
      target: "es2022",
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: devHmrPort,
        }
      : undefined,
    watch: {
      // 3. Tell Vite's file watcher to ignore large / churny trees that don't
      //    need HMR. On Windows each watched directory costs one
      //    ReadDirectoryChangesW handle; build churn (src-tauri/obj, dotnet,
      //    parallel-agent worktrees) leaks them, and left unbounded the dev
      //    server accrued ~46k handles within minutes of startup. The compile
      //    -server apphost.exe in obj/ can also be locked by dotnet while
      //    Tauri rebuilds, making Node's fs watcher exit on EBUSY.
      //    node_modules & .git are already ignored by Vite's defaults; the
      //    rest mirrors .gitignore.
      ignored: [
        // native / .NET build outputs (locked & churny during tauri dev)
        "**/src-tauri/**", // also covers src-tauri/gen managed runtimes (~1.4k dirs)
        "**/locus_compile_server/**/bin/**",
        "**/locus_compile_server/**/obj/**",
        // workspace-only trees (see .gitignore)
        "**/.claude/**", // parallel-agent worktrees + session data (~9k dirs)
        "**/testproject/**",
        "**/ref/**",
        "**/plans/**",
        "**/experiments/**",
        "**/docs/**", // separate Mintlify site with its own node_modules
        // caches / temp / artifacts
        "**/.cache/**",
        "**/.tmp/**",
        "**/tmp/**",
        "**/debug/**",
        "**/.codex/**",
        "**/codex-artifacts/**",
        "**/.venv/**",
        "**/.venv-docs/**",
        // build output
        "**/dist/**",
        "**/dist-ssr/**",
        "**/site/**",
        // editor / logs
        "**/.vscode/**",
        "**/.idea/**",
        "**/logs/**",
        "**/*.log",
      ],
    },
  },
}));
