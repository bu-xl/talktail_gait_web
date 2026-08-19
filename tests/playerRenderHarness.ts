import { createCanvas } from "@napi-rs/canvas";

/**
 * Enough DOM for the player's renderers to run under node:test against a real
 * 2D context, so the assertions can read actual pixels instead of trusting a
 * mock to have been called.
 */
export interface Harness {
  makeCanvas(width: number, height: number): HTMLCanvasElement;
  cleanup(): void;
}

function attachDomShims(canvas: unknown, w: number, h: number): void {
  const c = canvas as Record<string, unknown>;
  c.getBoundingClientRect = () => ({
    width: w,
    height: h,
    top: 0,
    left: 0,
    right: w,
    bottom: h,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  c.clientWidth = w;
  c.clientHeight = h;
  if (c.id === undefined) c.id = "";
}

export function setupHarness(): Harness {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, devicePixelRatio: g.devicePixelRatio };

  g.devicePixelRatio = 1;
  g.document = {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`harness only makes canvases, got <${tag}>`);
      const c = createCanvas(1, 1);
      attachDomShims(c, 1, 1);
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
  };

  return {
    makeCanvas(width: number, height: number) {
      const c = createCanvas(width, height);
      attachDomShims(c, width, height);
      return c as unknown as HTMLCanvasElement;
    },
    cleanup() {
      g.document = saved.document;
      g.devicePixelRatio = saved.devicePixelRatio;
    },
  };
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): Rgba {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no context");
  const d = ctx.getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

/** Fraction of pixels with any opacity, for "did it draw anything" checks. */
export function coverage(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no context");
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
  return painted / (canvas.width * canvas.height);
}
