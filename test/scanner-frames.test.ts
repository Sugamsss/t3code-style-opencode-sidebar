import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { scannerFrameAt, scannerFrameCount, scannerShouldAnimate, scannerWidth } from "../scanner-frames";

const snapshot = (frame: readonly { glyph: string; color: RGBA }[]) => frame.map(({ glyph, color }) => [glyph, color.r, color.g, color.b, color.a]);

// Keep the pre-S2 calculation local so the test proves the refactor did not
// alter any glyph, alpha, phase, or direction in the finite sequence.
const oldFrame = (frame: number) => {
  const base = RGBA.fromHex("#22c55e");
  const cells = Array.from({ length: scannerWidth }, (_, index) => index);
  const state = frame < scannerWidth
    ? { activePosition: frame, holding: false, holdProgress: 0, holdTotal: 0, movingForward: true, movementProgress: frame, movementTotal: scannerWidth }
    : frame < scannerWidth + 9
      ? { activePosition: scannerWidth - 1, holding: true, holdProgress: frame - scannerWidth, holdTotal: 9, movingForward: true, movementProgress: 0, movementTotal: 0 }
      : frame < scannerWidth + 9 + scannerWidth - 1
        ? { activePosition: scannerWidth - 2 - (frame - scannerWidth - 9), holding: false, holdProgress: 0, holdTotal: 0, movingForward: false, movementProgress: frame - scannerWidth - 9, movementTotal: scannerWidth - 1 }
        : { activePosition: 0, holding: true, holdProgress: frame - scannerWidth - 9 - (scannerWidth - 1), holdTotal: 30, movingForward: false, movementProgress: 0, movementTotal: 0 };
  return cells.map((charIndex) => {
    const distance = state.movingForward ? state.activePosition - charIndex : charIndex - state.activePosition;
    const index = state.holding ? distance + state.holdProgress : distance > 0 && distance < 6 ? distance : distance === 0 ? 0 : -1;
    const progress = state.holding ? Math.min(state.holdProgress / state.holdTotal, 1) : Math.min(state.movementProgress / Math.max(1, state.movementTotal - 1), 1);
    const fade = state.holding ? Math.max(0.3, 1 - progress * 0.7) : 0.3 + progress * 0.7;
    const inactive = RGBA.fromValues(base.r, base.g, base.b, 0.6 * fade);
    if (index < 0 || index >= 6) return { glyph: "⬝", color: inactive };
    if (index === 0) return { glyph: "■", color: RGBA.fromValues(base.r, base.g, base.b, 1) };
    if (index === 1) return { glyph: "■", color: RGBA.fromValues(Math.min(1, base.r * 1.15), Math.min(1, base.g * 1.15), Math.min(1, base.b * 1.15), 0.9) };
    return { glyph: "■", color: RGBA.fromValues(base.r, base.g, base.b, Math.pow(0.65, index - 1)) };
  });
};

describe("shared scanner frames", () => {
  test("matches the old output for every frame", () => {
    for (let frame = 0; frame < scannerFrameCount; frame++) expect(snapshot(scannerFrameAt(frame))).toEqual(snapshot(oldFrame(frame)));
  });
  test("gates animation on the sidebar and a mounted expanded rail", () => {
    expect(scannerShouldAnimate(true, true)).toBe(true);
    expect(scannerShouldAnimate(false, true)).toBe(false);
    expect(scannerShouldAnimate(true, false)).toBe(false);
  });
});
