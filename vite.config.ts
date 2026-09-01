import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

import { renderThemeTokensCss } from "./src/styles/tokens";

const host = process.env.TAURI_DEV_HOST;

/** Placeholder in `index.html` that the generated token block replaces. */
const THEME_TOKENS_MARKER = "<!--THEME_TOKENS-->";

/**
 * Render the theme tokens from `src/styles/tokens.ts` into the document head.
 *
 * They belong there rather than in `src/index.css` because the startup screen
 * needs them before any bundle has loaded. Emitting them from one module is
 * what stops the app stylesheet and the startup screen drifting apart - which
 * they had, leaving the splash accent stuck on the dark theme's blue in every
 * theme.
 *
 * The block is deliberately unlayered, so it wins over anything Tailwind puts
 * in `@layer base` and there is no ordering subtlety to remember.
 */
function themeTokensPlugin(): Plugin {
  let isBuild = false;
  return {
    name: "project-terminal:theme-tokens",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const block = `<style>\n${renderThemeTokensCss("      ")}\n    </style>`;
        if (html.includes(THEME_TOKENS_MARKER)) {
          return html.replace(THEME_TOKENS_MARKER, block);
        }
        // Failing the build is right: a bundle whose entry HTML carries no
        // palette renders as an unstyled black window, and that is not
        // something to ship.
        if (isBuild) {
          throw new Error(
            `index.html is missing the ${THEME_TOKENS_MARKER} placeholder; theme tokens have nowhere to go.`,
          );
        }
        // In dev it is not. Throwing here makes the dev server serve an error
        // for the entry document, and a Tauri window with no document is a
        // black rectangle with no clue in it. Warn and inject anyway.
        //
        // `console.warn` rather than the plugin context's `this.warn`: the
        // object form of `transformIndexHtml` does not bind one, so reaching
        // for it throws - which is the failure this branch exists to avoid.
        console.warn(
          `[theme-tokens] index.html is missing ${THEME_TOKENS_MARKER}; injecting at the end of <head>.`,
        );
        return html.includes("</head>")
          ? html.replace("</head>", `${block}\n  </head>`)
          : block + html;
      },
    },
  };
}

// https://vitejs.dev/config/
//
// The `test` field below is only known to TypeScript because Vitest augments
// vite's `UserConfig` type - but that augmentation lands on the copy of
// `vite` that Vitest itself resolves in this workspace's dependency tree,
// which pnpm has pinned to a different (older) version than the `vite`
// imported above. Passing the config object directly to `defineConfig` runs
// afoul of that mismatch (`test` looks unknown against the wrong overload).
// Wrapping it in a function sidesteps the excess-property check that trips
// over it; this is not dead ceremony, so keep it until the lockfile's vitest
// and vite versions line up.
export default defineConfig(async () => ({
  plugins: [themeTokensPlugin(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Tauri expects a fixed port, fail if that port is not available
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tell vite to ignore watching src-tauri
      ignored: ["**/src-tauri/**"],
    },
  },
  // No `manualChunks`: Rollup's default per-entry-point chunking already
  // respects this app's `React.lazy` boundaries (dialogs, settings panels,
  // the memo preview). The previous manual grouping put every icon used
  // anywhere - including ones only reachable from a lazy chunk - and all six
  // Radix packages into chunks that load eagerly with the entry point,
  // undoing that lazy-loading work.
  build: {
    // This app only ever runs inside Windows WebView2, not a general
    // browser, so the build can target its Chromium version directly
    // instead of transpiling down for broader compatibility.
    target: "chrome105",
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
}));
