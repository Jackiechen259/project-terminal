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
  return {
    name: "project-terminal:theme-tokens",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes(THEME_TOKENS_MARKER)) {
          throw new Error(
            `index.html is missing the ${THEME_TOKENS_MARKER} placeholder; theme tokens have nowhere to go.`,
          );
        }
        const css = renderThemeTokensCss("      ");
        return html.replace(
          THEME_TOKENS_MARKER,
          `<style>\n${css}\n    </style>`,
        );
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
