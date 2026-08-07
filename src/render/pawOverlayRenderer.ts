/**
 * Canvas drawing of the paw overlay (boxes + cross + label + pressure + header).
 *
 * Shared by the LIVE view, the exported GIF and the peak PNG, so the annotation
 * looks identical everywhere. Depends only on a minimal Canvas-2D surface
 * (`Ctx2D`), so it runs against the browser canvas AND a headless Node canvas
 * (@napi-rs/canvas) without DOM-type coupling.
 */

import {
  FF_PROVISIONAL_CONFIDENCE_MAX,
} from "../gait/footfall/constants.js";
import {
  PAW_COLORS,
  fieldStatsInBBox,
  type PawOverlayFrame,
} from "../gait/overlayModel.js";

/** The slice of CanvasRenderingContext2D we actually use (browser + node). */
export interface Ctx2D {
  save(): void;
  restore(): void;
  lineWidth: number;
  strokeStyle: string;
  fillStyle: string;
  font: string;
  textBaseline: string;
  lineJoin: string;
  globalAlpha: number;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

export interface OverlayRenderOptions {
  canvasW: number;
  canvasH: number;
  gridRows: number;
  gridCols: number;
  /** Display pressure field (row-major). If given, the printed number is the
   *  peak display pressure in the box, so it matches the heatmap colours. */
  field?: ArrayLike<number>;
  /** Unit suffix for the printed pressure (e.g. "rel" / "mmHg"). */
  unit?: string;
  /** Top header text (e.g. "t=1.20s f48/240 paws:4"). Omit for none. */
  header?: string;
  /** Outline width in px (auto from canvas size if omitted). */
  lineWidth?: number;
  /** Label font px (auto if omitted). */
  fontPx?: number;
  /** Draw the centre cross (default true). */
  showCross?: boolean;
  /** Fade Unknown boxes (default true). */
  dimUnknown?: boolean;
}

const rgb = (c: readonly [number, number, number]): string => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Draw all paw annotations for one frame onto `ctx`. */
export function drawPawOverlay(
  ctx: Ctx2D,
  frame: PawOverlayFrame,
  o: OverlayRenderOptions,
): void {
  const sx = o.canvasW / o.gridCols;
  const sy = o.canvasH / o.gridRows;
  const font = o.fontPx ?? Math.max(11, Math.round(o.canvasW * 0.058));
  const lw = o.lineWidth ?? Math.max(2, Math.round(o.canvasW / 110));
  const pad = Math.max(2, Math.round(font * 0.18));
  const showCross = o.showCross !== false;
  const dimUnknown = o.dimUnknown !== false;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.textBaseline = "top";

  for (const item of frame.items) {
    const col = PAW_COLORS[item.label] ?? PAW_COLORS.Unknown;
    const stroke = rgb(col);
    const unknown = item.label === "Unknown";

    const x0 = item.bbox.minCol * sx;
    const y0 = item.bbox.minRow * sy;
    const x1 = (item.bbox.maxCol + 1) * sx;
    const y1 = (item.bbox.maxRow + 1) * sy;
    const w = Math.max(2, x1 - x0);
    const h = Math.max(2, y1 - y0);

    ctx.globalAlpha = unknown && dimUnknown ? 0.55 : 1;
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.strokeRect(x0 + lw / 2, y0 + lw / 2, Math.max(1, w - lw), Math.max(1, h - lw));

    // Centre-of-pressure cross.
    if (showCross) {
      const cx = (item.copCol + 0.5) * sx;
      const cy = (item.copRow + 0.5) * sy;
      const r = Math.max(4, sx * 0.9);
      ctx.lineWidth = Math.max(1, lw - 1);
      ctx.beginPath();
      ctx.moveTo(cx - r, cy);
      ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.stroke();
    }

    // Label tag, placed above the box (or below if there's no room), clamped to
    // stay on-canvas. The label encodes confidence: the L/R letter (reliable) is
    // drawn solid, while the F/H letter (a real-time GUESS) is separated by "~"
    // and drawn faint — e.g. "R~F". Unknown (cold-start) shows a grey "?".
    ctx.font = `bold ${font}px sans-serif`;
    let peakText = "";
    if (o.field) {
      const { peak } = fieldStatsInBBox(o.field, o.gridCols, item.bbox);
      if (peak > 0) peakText = `${Math.round(peak)}${o.unit ? o.unit : ""}`;
    }
    const segs: Array<{ t: string; a: number }> = [];
    const provisional =
      item.label !== "Unknown" && item.confidence < FF_PROVISIONAL_CONFIDENCE_MAX;
    if (item.label === "Unknown") {
      segs.push({ t: "?", a: 1 });
    } else if (provisional) {
      segs.push({ t: `${item.label}?`, a: 0.72 });
    } else {
      segs.push({ t: item.label[0]!, a: 1 }); // side L/R — reliable
      segs.push({ t: "~", a: 0.6 });
      segs.push({ t: item.label[1]!, a: 0.5 }); // F/H — guess (faint)
    }
    if (peakText) segs.push({ t: ` ${peakText}`, a: 0.95 });

    const widths = segs.map((s) => ctx.measureText(s.t).width);
    const tw = widths.reduce((a, b) => a + b, 0);
    const boxW = tw + pad * 2;
    const boxH = font + pad * 2;
    let tx = x0;
    if (tx + boxW > o.canvasW) tx = o.canvasW - boxW;
    if (tx < 0) tx = 0;
    let ty = y0 - boxH - 1;
    if (ty < 0) ty = y1 + 1;
    if (ty + boxH > o.canvasH) ty = Math.max(0, o.canvasH - boxH);

    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(0,0,0,0.74)";
    ctx.fillRect(tx, ty, boxW, boxH);
    let sx2 = tx + pad;
    for (let si = 0; si < segs.length; si++) {
      ctx.globalAlpha = segs[si]!.a;
      ctx.fillStyle = stroke;
      ctx.fillText(segs[si]!.t, sx2, ty + pad);
      sx2 += widths[si]!;
    }
    ctx.globalAlpha = 1;
  }

  if (o.header) {
    const hFont = Math.max(10, Math.round(font * 0.82));
    const barH = hFont + 8;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(0,0,0,0.68)";
    ctx.fillRect(0, 0, o.canvasW, barH);
    ctx.font = `bold ${hFont}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(o.header, 5, 4);
  }

  ctx.restore();
}
