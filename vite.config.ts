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
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "zustand"],
          "terminal-vendor": [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-image",
            "@xterm/addon-search",
            "@xterm/addon-unicode-graphemes",
            "@xterm/addon-web-links",
          ],
          "terminal-webgl": ["@xterm/addon-webgl"],
          "ui-vendor": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-label",
            "@radix-ui/react-select",
            "@radix-ui/react-slot",
            "@radix-ui/react-tooltip",
          ],
          "icons-vendor": ["lucide-react"],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
}));
