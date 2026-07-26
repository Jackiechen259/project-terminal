import { describe, expect, it, vi } from "vitest";

import { terminalService } from "./index";

describe("terminalService.decodeBase64", () => {
  it("decodes arbitrary terminal bytes", () => {
    expect([...terminalService.decodeBase64("AP+AQUNE")]).toEqual([
      0x00, 0xff, 0x80, 0x41, 0x43, 0x44,
    ]);
  });

  it("uses the native typed-array decoder when the WebView provides it", () => {
    const previous = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    const nativeDecoder = vi.fn(() => Uint8Array.from([1, 2, 3]));
    Object.defineProperty(Uint8Array, "fromBase64", {
      configurable: true,
      value: nativeDecoder,
    });

    try {
      expect([...terminalService.decodeBase64("ignored")]).toEqual([1, 2, 3]);
      expect(nativeDecoder).toHaveBeenCalledWith("ignored");
    } finally {
      if (previous) {
        Object.defineProperty(Uint8Array, "fromBase64", previous);
      } else {
        Reflect.deleteProperty(Uint8Array, "fromBase64");
      }
    }
  });
});
