import { RGBA } from "@opentui/core";

export const scannerWidth = 8;
export const scannerFrameCount = scannerWidth + 9 + (scannerWidth - 1) + 30;
export const scannerCells = Object.freeze(Array.from({ length: scannerWidth }, (_, index) => index));

export type ScannerCell = Readonly<{ glyph: string; color: RGBA }>;
export type ScannerFrame = readonly ScannerCell[];

// Parse the active color once. The resulting finite frame table is shared by
// every rail; rails only read from it and never create or mutate cells.
const scannerBase = RGBA.fromHex("#22c55e");

const frameFor = (frame: number): ScannerFrame => {
  const state = frame < scannerWidth
    ? { activePosition: frame, holding: false, holdProgress: 0, holdTotal: 0, movingForward: true, movementProgress: frame, movementTotal: scannerWidth }
    : frame < scannerWidth + 9
      ? { activePosition: scannerWidth - 1, holding: true, holdProgress: frame - scannerWidth, holdTotal: 9, movingForward: true, movementProgress: 0, movementTotal: 0 }
      : frame < scannerWidth + 9 + scannerWidth - 1
        ? { activePosition: scannerWidth - 2 - (frame - scannerWidth - 9), holding: false, holdProgress: 0, holdTotal: 0, movingForward: false, movementProgress: frame - scannerWidth - 9, movementTotal: scannerWidth - 1 }
        : { activePosition: 0, holding: true, holdProgress: frame - scannerWidth - 9 - (scannerWidth - 1), holdTotal: 30, movingForward: false, movementProgress: 0, movementTotal: 0 };

  return Object.freeze(scannerCells.map((charIndex) => {
    const distance = state.movingForward ? state.activePosition - charIndex : charIndex - state.activePosition;
    const index = state.holding ? distance + state.holdProgress : distance > 0 && distance < 6 ? distance : distance === 0 ? 0 : -1;
    const progress = state.holding ? Math.min(state.holdProgress / state.holdTotal, 1) : Math.min(state.movementProgress / Math.max(1, state.movementTotal - 1), 1);
    const fade = state.holding ? Math.max(0.3, 1 - progress * 0.7) : 0.3 + progress * 0.7;
    const inactive = RGBA.fromValues(scannerBase.r, scannerBase.g, scannerBase.b, 0.6 * fade);
    if (index < 0 || index >= 6) return Object.freeze({ glyph: "⬝", color: inactive });
    if (index === 0) return Object.freeze({ glyph: "■", color: RGBA.fromValues(scannerBase.r, scannerBase.g, scannerBase.b, 1) });
    if (index === 1) return Object.freeze({ glyph: "■", color: RGBA.fromValues(Math.min(1, scannerBase.r * 1.15), Math.min(1, scannerBase.g * 1.15), Math.min(1, scannerBase.b * 1.15), 0.9) });
    return Object.freeze({ glyph: "■", color: RGBA.fromValues(scannerBase.r, scannerBase.g, scannerBase.b, Math.pow(0.65, index - 1)) });
  }));
};

export const scannerFrames = Object.freeze(Array.from({ length: scannerFrameCount }, (_, frame) => frameFor(frame)));
export const scannerFrameAt = (frame: number) => scannerFrames[frame % scannerFrameCount];
export const scannerShouldAnimate = (sidebarOpen: boolean, expandedRunningRail: boolean) => sidebarOpen && expandedRunningRail;
