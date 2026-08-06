import type { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";

/**
 * Which renderer a terminal is currently drawing with.
 *
 * `dom` is not a failure - it is where every terminal starts, because DOM
 * rendering can paint the first prompt while the WebGL chunk is still
 * downloading. `degraded` means WebGL was wanted, was tried, and has stopped
 * coming back.
 */
export type RendererState = "dom" | "webgl" | "degraded";

/** What the user asked for. `auto` upgrades to WebGL when it works. */
export type RendererPreference = "auto" | "webgl" | "dom";

/**
 * Delays before each retry after a lost context, in milliseconds.
 *
 * Context loss on Windows is routine rather than exceptional - a driver
 * update, an RDP session transition, a hybrid-graphics switch, a TDR reset -
 * and the GPU is usually back within seconds. Retrying immediately would
 * fail during the reset itself, so the first wait is short and the rest back
 * off.
 *
 * The budget is spent over the terminal's whole life rather than reset on
 * each recovery. A machine that loses the context four times will lose it a
 * fifth, and a terminal that flickers between renderers all session is worse
 * than one that settles on the DOM. Choosing a renderer explicitly in
 * settings hands the budget back.
 */
const RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

type Timer = ReturnType<typeof setTimeout>;

export interface TerminalRendererOptions {
  /** Loads the WebGL addon. Injected so tests need no bundler and no GPU. */
  loadAddon: () => Promise<{ new (): WebglAddon }>;
  onStateChange?: (state: RendererState) => void;
  setTimeoutFn?: (callback: () => void, delay: number) => Timer;
  clearTimeoutFn?: (timer: Timer) => void;
}

/**
 * Owns a terminal's WebGL addon, including getting it back after the GPU
 * takes it away.
 *
 * Previously a lost context disposed the addon and that was the end of it:
 * the session ran on the DOM renderer until the tab was closed, with no
 * notice. That matters beyond speed - the two renderers have different glyph
 * metrics, so box-drawing characters gain visible seams and `customGlyphs`
 * stops applying, which is what draws Powerline separators.
 */
export class TerminalRenderer {
  private addon: WebglAddon | null = null;
  private disposed = false;
  private attempt = 0;
  private retryTimer: Timer | null = null;
  private preference: RendererPreference = "auto";
  private state: RendererState = "dom";
  private readonly setTimeoutFn: (callback: () => void, delay: number) => Timer;
  private readonly clearTimeoutFn: (timer: Timer) => void;

  constructor(
    private readonly term: Terminal,
    private readonly options: TerminalRendererOptions,
  ) {
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((callback, delay) => setTimeout(callback, delay) as Timer);
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
  }

  currentState(): RendererState {
    return this.state;
  }

  /** Apply a preference, loading or unloading WebGL as needed. */
  setPreference(preference: RendererPreference) {
    if (this.disposed || this.preference === preference) return;
    this.preference = preference;
    this.cancelRetry();
    if (preference === "dom") {
      this.addon?.dispose();
      this.addon = null;
      this.publish("dom");
      return;
    }
    // A new preference is a fresh start: a user who explicitly asks for WebGL
    // after a bad patch of driver resets should not inherit a spent budget.
    this.attempt = 0;
    void this.load();
  }

  dispose() {
    this.disposed = true;
    this.cancelRetry();
    this.addon?.dispose();
    this.addon = null;
  }

  private publish(state: RendererState) {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private cancelRetry() {
    if (this.retryTimer !== null) {
      this.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async load() {
    if (this.disposed || this.preference === "dom" || this.addon) return;
    let WebglAddonCtor: { new (): WebglAddon };
    try {
      WebglAddonCtor = await this.options.loadAddon();
    } catch {
      // The chunk could not be fetched. The DOM renderer is fully functional,
      // so this is not worth retrying on a timer.
      this.publish(this.preference === "webgl" ? "degraded" : "dom");
      return;
    }
    if (this.disposed) return;

    try {
      const addon = new WebglAddonCtor();
      addon.onContextLoss(() => this.handleContextLoss());
      this.term.loadAddon(addon);
      this.addon = addon;
      this.publish("webgl");
    } catch {
      // Construction throws when the machine has no usable WebGL at all -
      // a blocklisted driver, or a remote session with no GPU. Retrying
      // buys nothing there, and the retry budget is for lost contexts.
      this.addon = null;
      this.publish("degraded");
    }
  }

  private handleContextLoss() {
    this.addon?.dispose();
    this.addon = null;
    this.publish("dom");
    if (this.disposed || this.preference === "dom") return;

    const delay = RETRY_DELAYS_MS[this.attempt];
    if (delay === undefined) {
      // Losing the context this many times is a real problem with the
      // machine, not a transient one. Stop asking.
      this.publish("degraded");
      return;
    }
    this.attempt += 1;
    this.cancelRetry();
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      void this.load();
    }, delay);
  }

  /** Start the initial upgrade. Safe to call once, after `term.open()`. */
  start(preference: RendererPreference) {
    this.preference = preference;
    if (preference === "dom") {
      this.publish("dom");
      return;
    }
    void this.load();
  }
}
