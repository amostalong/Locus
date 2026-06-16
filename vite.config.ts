import path from "node:path";
import { defineConfig, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteStaticCopy } from "vite-plugin-static-copy";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

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
          src: normalizePath(path.resolve(__dirname, "node_modules/vditor/dist/**/*")),
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
    chunkSizeWarningLimit: 800, // three.js chunk ~725KB, already lazy-loaded
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "three-preview";
          if (id.includes("node_modules/ag-psd")) return "binary-preview";
          if (
            id.includes("node_modules/monaco-editor")
            || id.includes("node_modules/@codingame/")
            || id.includes("node_modules/monaco-languageclient")
            || id.includes("node_modules/vscode-languageclient")
            || id.includes("node_modules/vscode-languageserver-protocol")
            || id.includes("node_modules/vscode-jsonrpc")
          ) return "monaco";
          if (
            id.includes("node_modules/vue")
            || id.includes("node_modules/pinia")
            || id.includes("node_modules/marked")
            || id.includes("node_modules/highlight.js")
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
    port: 14901,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
