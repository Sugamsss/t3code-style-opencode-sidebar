import { describe, expect, test } from "bun:test";
import { GLYPHS } from "../sidebar-glyphs";

describe("sidebar glyph system", () => {
  test("defines single-weight clean symbols", () => {
    expect(GLYPHS.add).toBe("+");
    expect(GLYPHS.delete).toBe("×");
    expect(GLYPHS.settle).toBe("✓");
    expect(GLYPHS.disclosure.open).toBe("▾");
    expect(GLYPHS.disclosure.closed).toBe("▸");
    expect(GLYPHS.disclosure.select).toBe("⌄");
    expect(GLYPHS.pointer).toBe("❯");
  });
});
