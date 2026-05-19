import path from "node:path";
import { defineConfig, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteStaticCopy } from "vite-plugin-static-copy";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
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

  worker: {
    format: "es",
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
