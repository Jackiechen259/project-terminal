/**
 * The single source of truth for every theme colour in the application.
 *
 * These values are consumed twice, from here, at build time:
 *
 * - `src/index.css` no longer declares them. The Vite plugin in
 *   `vite.config.ts` renders them into a `<style>` block in the document head,
 *   which is also what makes them available to the pre-React startup screen in
 *   `index.html`.
 * - Tailwind reads them indirectly: `tailwind.config.ts` maps its colour names
 *   to `hsl(var(--token))`, so a token added here is usable as a utility class
 *   once it is named there too.
 *
 * Values are bare HSL components (`H S% L%`), not complete colours, because
 * that is the form `hsl(var(--token) / <alpha>)` needs to express opacity
 * variants like `bg-primary/40`.
 *
 * Every theme must define every token. `tokens.test.ts` enforces that; a
 * missing entry used to mean a token silently kept the dark theme's value.
 */

export type ThemeName = "dark" | "eye-care" | "light";

/** Tokens shared with shadcn/ui, plus the app-chrome set layered on top. */
export interface ThemeTokens {
  background: string;
  foreground: string;
  card: string;
  "card-foreground": string;
  popover: string;
  "popover-foreground": string;
  primary: string;
  "primary-foreground": string;
  secondary: string;
  "secondary-foreground": string;
  muted: string;
  "muted-foreground": string;
  accent: string;
  "accent-foreground": string;
  destructive: string;
  "destructive-foreground": string;
  border: string;
  input: string;
  ring: string;
  /** Window background, behind every surface. */
  bg: string;
  /** Raised chrome: title bar, tab strip, sidebars. */
  surface: string;
  /** Raised twice: inputs and hovered rows on a surface. */
  "surface-2": string;
  warn: string;
  ok: string;
  scrollbar: string;
  "scrollbar-hover": string;
  /** The hairline that stands in for the window border we do not draw. */
  "frame-edge": string;
}

/** Whether a theme wants light or dark form controls and scrollbars. */
export const THEME_COLOR_SCHEME: Record<ThemeName, "dark" | "light"> = {
  dark: "dark",
  "eye-care": "light",
  light: "light",
};

export const THEME_TOKENS: Record<ThemeName, ThemeTokens> = {
  // zinc base. A single vivid blue accent replaces the neutral zinc primary;
  // focus rings share its hue.
  dark: {
    background: "240 10% 3.9%",
    foreground: "0 0% 98%",
    card: "240 10% 3.9%",
    "card-foreground": "0 0% 98%",
    popover: "240 10% 3.9%",
    "popover-foreground": "0 0% 98%",
    primary: "217.2 91.2% 59.8%",
    "primary-foreground": "222.2 47.4% 11.2%",
    secondary: "240 3.7% 15.9%",
    "secondary-foreground": "0 0% 98%",
    muted: "240 3.7% 15.9%",
    "muted-foreground": "240 5% 64.9%",
    accent: "240 3.7% 15.9%",
    "accent-foreground": "0 0% 98%",
    destructive: "0 72% 51%",
    "destructive-foreground": "0 0% 98%",
    border: "240 3.7% 15.9%",
    input: "240 3.7% 15.9%",
    ring: "217.2 91.2% 59.8%",
    bg: "240 10% 3.9%",
    surface: "240 6% 10%",
    "surface-2": "240 5% 14%",
    warn: "47.9 95.8% 53.1%",
    ok: "142.1 70.6% 45.3%",
    scrollbar: "240 5% 31%",
    "scrollbar-hover": "240 5% 45%",
    "frame-edge": "240 5% 20%",
  },
  // Warm paper. Low-blue and low-contrast on purpose, for long sessions.
  "eye-care": {
    background: "43 45% 93%",
    foreground: "35 18% 18%",
    card: "42 42% 96%",
    "card-foreground": "35 18% 18%",
    popover: "42 42% 97%",
    "popover-foreground": "35 18% 18%",
    primary: "33 25% 26%",
    "primary-foreground": "45 50% 97%",
    secondary: "40 30% 87%",
    "secondary-foreground": "35 20% 22%",
    muted: "40 25% 88%",
    "muted-foreground": "35 12% 42%",
    accent: "38 30% 84%",
    "accent-foreground": "35 22% 20%",
    destructive: "2 63% 43%",
    "destructive-foreground": "0 0% 100%",
    border: "38 22% 78%",
    input: "38 22% 78%",
    ring: "33 34% 45%",
    bg: "43 45% 93%",
    surface: "42 36% 90%",
    "surface-2": "40 28% 85%",
    warn: "40 85% 38%",
    ok: "140 45% 34%",
    scrollbar: "36 16% 58%",
    "scrollbar-hover": "34 18% 44%",
    "frame-edge": "38 22% 72%",
  },
  light: {
    background: "0 0% 100%",
    foreground: "240 10% 3.9%",
    card: "0 0% 100%",
    "card-foreground": "240 10% 3.9%",
    popover: "0 0% 100%",
    "popover-foreground": "240 10% 3.9%",
    primary: "221.2 83.2% 53.3%",
    "primary-foreground": "210 40% 98%",
    secondary: "240 4.8% 95.9%",
    "secondary-foreground": "240 5.9% 10%",
    muted: "240 4.8% 95.9%",
    "muted-foreground": "240 3.8% 46.1%",
    accent: "240 4.8% 95.9%",
    "accent-foreground": "240 5.9% 10%",
    destructive: "0 72.2% 50.6%",
    "destructive-foreground": "0 0% 98%",
    border: "240 5.9% 90%",
    input: "240 5.9% 90%",
    ring: "221.2 83.2% 53.3%",
    bg: "0 0% 100%",
    surface: "240 20% 98%",
    "surface-2": "240 4.8% 95.9%",
    warn: "38 92% 36%",
    ok: "142 56% 32%",
    scrollbar: "240 5% 65%",
    "scrollbar-hover": "240 4% 46%",
    "frame-edge": "240 6% 85%",
  },
};

/** Corner radius shared by every theme. Lives here so it is declared once. */
const RADIUS = "0.375rem";

/**
 * Render the token declarations as CSS.
 *
 * The dark theme doubles as the bare `:root` rule so a document that has not
 * had `data-theme` stamped on it yet - the first frames, before either the
 * inline script in `index.html` or React's layout effect runs - is still
 * fully styled rather than falling back to unset variables.
 */
export function renderThemeTokensCss(indent = ""): string {
  const rule = (selectors: string[], theme: ThemeName, extra = "") => {
    const head = selectors
      .map((selector) => `${indent}${selector}`)
      .join(",\n");
    const body = Object.entries(THEME_TOKENS[theme])
      .map(([token, value]) => `${indent}  --${token}: ${value};`)
      .join("\n");
    return `${head} {\n${indent}  color-scheme: ${THEME_COLOR_SCHEME[theme]};\n${body}\n${extra}${indent}}`;
  };

  return [
    rule(
      [":root", ':root[data-theme="dark"]'],
      "dark",
      `${indent}  --radius: ${RADIUS};\n`,
    ),
    rule([':root[data-theme="eye-care"]'], "eye-care"),
    rule([':root[data-theme="light"]'], "light"),
  ].join("\n\n");
}
