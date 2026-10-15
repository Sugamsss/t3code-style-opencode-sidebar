import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { colors } from "../index";

describe("sidebar theme colors", () => {
  test("uses the native TUI semantic tokens", () => {
    const resolved = colors({
      primary: "#8b7ec8",
      backgroundPanel: "#1c1b19",
      backgroundElement: "#282726",
      text: "#cecdc3",
      textMuted: "#878580",
      selectedListItemText: "#f2f0e5",
      border: "#403e3c",
    });

    expect(resolved.surface).toBe("#1c1b19");
    expect(resolved.raised).toBe("#282726");
    expect(resolved.selected).toBe("#f2f0e5");
    expect(resolved.border).toBe("#403e3c");
  });

  test("uses V2 semantic tokens instead of the blue fallback", () => {
    const resolved = colors({
      background: { base: "#100f0d", raised: { base: "#1c1b19", high: "#282726" } },
      text: {
        base: "#cecdc3",
        muted: "#878580",
        action: { primary: { base: "#8b7ec8" } },
      },
      border: { base: "#403e3c" },
    });

    expect(resolved.surface).toBe("#1c1b19");
    expect(resolved.raised).toBe("#282726");
    expect(resolved.text).toBe("#cecdc3");
    expect(resolved.muted).toBe("#878580");
    expect(resolved.border).toBe("#403e3c");
  });

  test("supports the live current-theme panel aliases", () => {
    const resolved = colors({
      current: { backgroundPanel: "#1c1b19", backgroundElement: "#282726" },
      background: "#100f0d",
      text: "#cecdc3",
      textMuted: "#878580",
      border: "#403e3c",
    });

    expect(resolved.surface).toBe("#1c1b19");
    expect(resolved.raised).toBe("#282726");
  });

  test("reads the live V2 RGBA theme.current shape", () => {
    const resolved = colors({
      current: {
        background: RGBA.fromHex("#100f0d"),
        backgroundPanel: RGBA.fromHex("#1c1b19"),
        backgroundElement: RGBA.fromHex("#282726"),
        text: RGBA.fromHex("#cecdc3"),
        textMuted: RGBA.fromHex("#878580"),
        border: RGBA.fromHex("#403e3c"),
      },
    });

    expect(resolved.surface).toBe("#1c1b19ff");
    expect(resolved.raised).toBe("#282726ff");
    expect(resolved.surface).not.toBe("#100f0dff");
  });

  test("does not return an intermediate token object", () => {
    const resolved = colors({ background: { base: "#101010" }, text: { base: "#f0f0f0" } });

    expect(typeof resolved.surface).toBe("string");
    expect(typeof resolved.text).toBe("string");
  });
});
