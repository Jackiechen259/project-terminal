import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";

import { TerminalRenderer, type RendererState } from "./terminalRenderer";

/**
 * A controllable stand-in for the WebGL addon and the timers around it.
 *
 * The whole point of injecting both is that the retry loop can be driven
 * without a GPU: `loseContext()` fires what the driver would, and `advance()`
 * is the clock.
 */
function harness({ failConstruction = false, failLoad = false } = {}) {
  const states: RendererState[] = [];
  const contextLossHandlers: Array<() => void> = [];
  const disposed: WebglAddon[] = [];
  let constructed = 0;
  const pending: Array<{ at: number; callback: () => void }> = [];
  let now = 0;

  class FakeWebglAddon {
    constructor() {
      constructed += 1;
      if (failConstruction) throw new Error("no WebGL on this machine");
    }
    onContextLoss(handler: () => void) {
      contextLossHandlers.push(handler);
    }
    dispose() {
      disposed.push(this as unknown as WebglAddon);
    }
  }

  const term = { loadAddon: vi.fn() } as unknown as Terminal;
  const renderer = new TerminalRenderer(term, {
    loadAddon: failLoad
      ? () => Promise.reject(new Error("chunk unavailable"))
      : () =>
          Promise.resolve(FakeWebglAddon as unknown as { new (): WebglAddon }),
    onStateChange: (state) => states.push(state),
    setTimeoutFn: (callback, delay) => {
      const timer = { at: now + delay, callback };
      pending.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (timer) => {
      const index = pending.indexOf(
        timer as unknown as (typeof pending)[number],
      );
      if (index >= 0) pending.splice(index, 1);
    },
  });

  return {
    renderer,
    states,
    disposed,
    get constructed() {
      return constructed;
    },
    loseContext: () => contextLossHandlers.pop()?.(),
    /** Run every timer due within `ms`, then let promises settle. */
    advance: async (ms: number) => {
      now += ms;
      const due = pending.filter((timer) => timer.at <= now);
      for (const timer of due) pending.splice(pending.indexOf(timer), 1);
      for (const timer of due) timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    },
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingTimers: () => pending.length,
  };
}

describe("TerminalRenderer", () => {
  it("upgrades to WebGL once the addon arrives", async () => {
    const h = harness();
    h.renderer.start("auto");
    await h.settle();

    expect(h.renderer.currentState()).toBe("webgl");
    expect(h.states).toEqual(["webgl"]);
  });

  it("recovers from a lost context after backing off", async () => {
    // Context loss on Windows is routine - driver updates, RDP transitions,
    // hybrid-graphics switches. Before this, one loss meant the session ran
    // on the DOM renderer until the tab closed.
    const h = harness();
    h.renderer.start("auto");
    await h.settle();

    h.loseContext();
    expect(h.renderer.currentState()).toBe("dom");
    expect(h.disposed).toHaveLength(1);

    await h.advance(1_000);
    expect(h.renderer.currentState()).toBe("webgl");
    expect(h.constructed).toBe(2);
  });

  it("gives up after the retry budget and says so", async () => {
    const h = harness();
    h.renderer.start("auto");
    await h.settle();

    // Three retries, each after a longer wait.
    for (const delay of [1_000, 4_000, 15_000]) {
      h.loseContext();
      await h.advance(delay);
      expect(h.renderer.currentState()).toBe("webgl");
    }

    h.loseContext();
    expect(h.renderer.currentState()).toBe("degraded");
    // Repeated loss is a problem with the machine, not a transient one.
    expect(h.pendingTimers()).toBe(0);
  });

  it("does not retry when the machine has no usable WebGL", async () => {
    // Construction throwing means a blocklisted driver or a session with no
    // GPU at all. The retry budget is for contexts that come back.
    const h = harness({ failConstruction: true });
    h.renderer.start("auto");
    await h.settle();

    expect(h.renderer.currentState()).toBe("degraded");
    expect(h.pendingTimers()).toBe(0);
  });

  it("stays on the DOM renderer when the chunk cannot be fetched", async () => {
    // Not a degradation under `auto`: the DOM renderer is fully functional
    // and the user asked for whatever works.
    const h = harness({ failLoad: true });
    h.renderer.start("auto");
    await h.settle();

    expect(h.renderer.currentState()).toBe("dom");
  });

  it("honours an explicit DOM preference and can be switched back", async () => {
    const h = harness();
    h.renderer.start("dom");
    await h.settle();
    expect(h.constructed).toBe(0);
    expect(h.renderer.currentState()).toBe("dom");

    h.renderer.setPreference("webgl");
    await h.settle();
    expect(h.renderer.currentState()).toBe("webgl");

    h.renderer.setPreference("dom");
    expect(h.renderer.currentState()).toBe("dom");
    expect(h.disposed).toHaveLength(1);
  });

  it("gives a spent retry budget back when the user re-selects WebGL", async () => {
    const h = harness();
    h.renderer.start("auto");
    await h.settle();
    for (const delay of [1_000, 4_000, 15_000]) {
      h.loseContext();
      await h.advance(delay);
    }
    h.loseContext();
    expect(h.renderer.currentState()).toBe("degraded");

    h.renderer.setPreference("webgl");
    await h.settle();
    expect(h.renderer.currentState()).toBe("webgl");
  });

  it("cancels a scheduled retry when disposed", async () => {
    const h = harness();
    h.renderer.start("auto");
    await h.settle();
    h.loseContext();
    expect(h.pendingTimers()).toBe(1);

    h.renderer.dispose();
    expect(h.pendingTimers()).toBe(0);

    await h.advance(60_000);
    // Two: the initial load and nothing since.
    expect(h.constructed).toBe(1);
  });
});
