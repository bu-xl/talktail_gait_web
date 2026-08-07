/**
 * Render a GaitSummary into a one-page A4 PDF report.
 *
 * The report is drawn onto an offscreen canvas (so any language, incl. Korean,
 * renders with the browser's fonts) and then embedded as a JPEG in a minimal
 * PDF (see jpegPdf.ts). No font embedding, no external dependencies.
 */

import type { GaitSummary, GaitPawRow } from "../core/gaitAnalysis.js";
import type { PawLabel } from "../gait/index.js";
import { jpegToPdf } from "./jpegPdf.js";

// A4 portrait at ~150 dpi.
const W = 1240;
const H = 1754;
const M = 70; // page margin

const COL = {
  bg: "#ffffff",
  ink: "#16202b",
  sub: "#5b6b7b",
  line: "#dce3ea",
  panel: "#f4f7fa",
  accent: "#2b6cb0",
  good: "#2f855a",
  warn: "#b7791f",
  bad: "#c53030",
  pawOn: "#2b6cb0",
  pawOff: "#cbd5e0",
};

const VALIDITY_COLOR: Record<GaitSummary["validity"], string> = {
  VALID: COL.good,
  PARTIAL: COL.warn,
  INVALID: COL.bad,
};

const VALIDITY_KO: Record<GaitSummary["validity"], string> = {
  VALID: "정상 (VALID)",
  PARTIAL: "부분 (PARTIAL)",
  INVALID: "분석 불가 (INVALID)",
};

const DIRECTION_KO: Record<GaitSummary["direction"], string> = {
  left_to_right: "왼쪽 → 오른쪽",
  right_to_left: "오른쪽 → 왼쪽",
  unknown: "판정 불가",
};

const num = (x: number | null | undefined, d = 1, unit = ""): string =>
  x == null || !Number.isFinite(x) ? "–" : `${x.toFixed(d)}${unit}`;

/** Draw the report onto a fresh canvas and return it. */
export function renderGaitReportCanvas(s: GaitSummary): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for PDF report");
  // Korean-first font stack: native OS fonts on Mac/Windows, Noto CJK as a
  // cross-platform/headless fallback, then Latin fonts for digits/labels.
  const font = (px: number, weight = 400): string =>
    `${weight} ${px}px "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR", ` +
    `"Noto Sans KR", "Helvetica Neue", Arial, system-ui, sans-serif`;

  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);

  let y = M;

  // ── Title ─────────────────────────────────────────────────────────────
  ctx.fillStyle = COL.ink;
  ctx.font = font(40, 700);
  ctx.textBaseline = "top";
  ctx.fillText("강아지 보행 분석 리포트", M, y);
  ctx.fillStyle = COL.sub;
  ctx.font = font(20, 400);
  ctx.fillText("Canine Gait Analysis Report", M, y + 50);

  // Validity badge (top-right)
  const badge = VALIDITY_KO[s.validity];
  ctx.font = font(22, 700);
  const bw = ctx.measureText(badge).width + 44;
  const bx = W - M - bw;
  roundRect(ctx, bx, y + 4, bw, 46, 10);
  ctx.fillStyle = VALIDITY_COLOR[s.validity];
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(badge, bx + 22, y + 15);

  y += 96;
  hline(ctx, M, y, W - M);
  y += 28;

  // ── Overview grid ─────────────────────────────────────────────────────
  ctx.fillStyle = COL.ink;
  ctx.font = font(24, 700);
  ctx.fillText("개요 · Overview", M, y);
  y += 42;

  const ts = new Date(s.analyzedAt);
  const overview: Array<[string, string]> = [
    ["측정 일시", ts.toLocaleString("ko-KR")],
    ["강아지 체중", num(s.weightKg, 1, " kg")],
    ["진행 방향", `${DIRECTION_KO[s.direction]} (${num(s.directionConfidence * 100, 0, "%")})`],
    ["측정 시간", num(s.durationSec, 2, " s")],
    ["프레임 수", `${s.frameCount}`],
    ["유효 샘플링", `${num(s.effectiveHz, 1, " Hz")} · ${num(s.samplesPerStance, 1)}/stance`],
    ["케이던스", num(s.cadenceHz, 2, " Hz")],
    ["속도", num(s.velocity, 2, " cell/s")],
    ["스텝/스트라이드", `${num(s.stepLength, 1)} / ${num(s.strideLength, 1)} cell`],
    ["검출된 발", s.detectedPaws.length ? s.detectedPaws.join(", ") : "없음"],
  ];
  y = drawKvGrid(ctx, overview, M, y, W - 2 * M, font);
  y += 24;

  // ── Paw diagram + load distribution ──────────────────────────────────
  ctx.fillStyle = COL.ink;
  ctx.font = font(24, 700);
  ctx.fillText("하중 분포 · Load Distribution", M, y);
  y += 42;

  const diagram = { x: M, y, w: 380, h: 300 };
  drawPawDiagram(ctx, s, diagram, font);

  // Load bars to the right of the diagram
  const barsX = M + 430;
  const barsW = W - M - barsX;
  let by = y + 6;
  const order: PawLabel[] = ["LF", "RF", "LH", "RH"];
  const nameKo: Record<PawLabel, string> = { LF: "왼앞 LF", RF: "오앞 RF", LH: "왼뒤 LH", RH: "오뒤 RH" };
  for (const lbl of order) {
    by = drawLoadBar(ctx, nameKo[lbl], s.loadPct[lbl], barsX, by, barsW, font);
  }
  by += 8;
  ctx.fillStyle = COL.sub;
  ctx.font = font(19, 400);
  ctx.fillText(
    `앞발 ${num(s.loadDist.forePct, 0, "%")} · 뒷발 ${num(s.loadDist.hindPct, 0, "%")}` +
      `   |   좌 ${num(s.loadDist.leftPct, 0, "%")} · 우 ${num(s.loadDist.rightPct, 0, "%")}`,
    barsX,
    by,
  );
  y = Math.max(diagram.y + diagram.h, by) + 36;

  // ── Symmetry ─────────────────────────────────────────────────────────
  ctx.fillStyle = COL.ink;
  ctx.font = font(24, 700);
  ctx.fillText("좌우 대칭 · Symmetry", M, y);
  y += 42;
  if (s.symmetry) {
    const sym: Array<[string, string]> = [
      [
        "앞발 대칭 지수",
        `${num(s.symmetry.fore.symmetryIndex, 1, "%")}${s.symmetry.fore.warning ? "  ⚠ 비대칭" : "  정상"}`,
      ],
      [
        "뒷발 대칭 지수",
        `${num(s.symmetry.hind.symmetryIndex, 1, "%")}${s.symmetry.hind.warning ? "  ⚠ 비대칭" : "  정상"}`,
      ],
    ];
    y = drawKvGrid(ctx, sym, M, y, W - 2 * M, font, 2);
  } else {
    ctx.fillStyle = COL.sub;
    ctx.font = font(20, 400);
    ctx.fillText("4발이 모두 검출되지 않아 좌우 대칭 지표를 생성하지 않았습니다.", M, y);
    y += 34;
  }
  y += 24;

  // ── Per-paw metrics table ─────────────────────────────────────────────
  ctx.fillStyle = COL.ink;
  ctx.font = font(24, 700);
  ctx.fillText("발별 상세 지표 · Per-paw Metrics", M, y);
  y += 40;
  y = drawPawTable(ctx, s.paws, M, y, W - 2 * M, font);
  y += 26;

  // ── Notes / recommendation ────────────────────────────────────────────
  const notes: string[] = [];
  if (s.recommendation) notes.push(`• 권장: ${s.recommendation}`);
  if (s.missingPaws.length) notes.push(`• 미검출 발: ${s.missingPaws.join(", ")}`);
  if (s.reasons.length) notes.push(`• 사유: ${s.reasons.join("; ")}`);
  if (s.preprocessing.hotPixelCount > 0)
    notes.push(`• 마스킹된 hot pixel: ${s.preprocessing.hotPixelCount}개`);
  if (s.preprocessing.baselineInvalid)
    notes.push("• 무부하 baseline 확보 실패 — 강아지를 매트에서 내린 뒤 Calibrate 권장");
  if (notes.length) {
    ctx.fillStyle = COL.panel;
    const nh = 26 + notes.length * 30;
    roundRect(ctx, M, y, W - 2 * M, nh, 10);
    ctx.fill();
    ctx.fillStyle = COL.ink;
    ctx.font = font(19, 400);
    let ny = y + 16;
    for (const n of notes) {
      ny = wrapText(ctx, n, M + 18, ny, W - 2 * M - 36, 28);
    }
    y += nh + 18;
  }

  // ── Footer disclaimer ────────────────────────────────────────────────
  ctx.fillStyle = COL.sub;
  ctx.font = font(16, 400);
  ctx.fillText(
    "본 리포트는 압력 매트 데이터 기반 스크리닝 결과이며, 수의학적 진단을 대체하지 않습니다.",
    M,
    H - M - 8,
  );

  return canvas;
}

/** Render the report to PDF bytes (JPEG-embedded, one A4 page). */
export async function gaitReportToPdfBytes(s: GaitSummary, quality = 0.92): Promise<Uint8Array> {
  const canvas = renderGaitReportCanvas(s);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", quality),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return jpegToPdf(bytes, canvas.width, canvas.height);
}

/* ──────────────────────────── drawing helpers ──────────────────────────── */

function hline(ctx: CanvasRenderingContext2D, x1: number, yy: number, x2: number): void {
  ctx.strokeStyle = COL.line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1, yy);
  ctx.lineTo(x2, yy);
  ctx.stroke();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  yy: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, yy);
  ctx.arcTo(x + w, yy, x + w, yy + h, r);
  ctx.arcTo(x + w, yy + h, x, yy + h, r);
  ctx.arcTo(x, yy + h, x, yy, r);
  ctx.arcTo(x, yy, x + w, yy, r);
  ctx.closePath();
}

function drawKvGrid(
  ctx: CanvasRenderingContext2D,
  rows: Array<[string, string]>,
  x: number,
  yy: number,
  w: number,
  font: (px: number, weight?: number) => string,
  cols = 2,
): number {
  const colW = w / cols;
  const rowH = 40;
  const nRows = Math.ceil(rows.length / cols);
  for (let i = 0; i < rows.length; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const cx = x + c * colW;
    const cy = yy + r * rowH;
    ctx.fillStyle = COL.sub;
    ctx.font = font(19, 400);
    ctx.fillText(rows[i][0], cx, cy);
    ctx.fillStyle = COL.ink;
    ctx.font = font(20, 600);
    ctx.fillText(rows[i][1], cx + 180, cy);
  }
  return yy + nRows * rowH;
}

function drawLoadBar(
  ctx: CanvasRenderingContext2D,
  label: string,
  pct: number,
  x: number,
  yy: number,
  w: number,
  font: (px: number, weight?: number) => string,
): number {
  ctx.fillStyle = COL.sub;
  ctx.font = font(18, 600);
  ctx.fillText(label, x, yy);
  const trackX = x + 110;
  const trackW = w - 170;
  ctx.fillStyle = COL.line;
  roundRect(ctx, trackX, yy + 2, trackW, 18, 9);
  ctx.fill();
  const filled = Math.max(0, Math.min(1, pct / 100)) * trackW;
  ctx.fillStyle = COL.accent;
  roundRect(ctx, trackX, yy + 2, Math.max(4, filled), 18, 9);
  ctx.fill();
  ctx.fillStyle = COL.ink;
  ctx.font = font(18, 600);
  ctx.fillText(num(pct, 0, "%"), trackX + trackW + 14, yy);
  return yy + 38;
}

function drawPawDiagram(
  ctx: CanvasRenderingContext2D,
  s: GaitSummary,
  box: { x: number; y: number; w: number; h: number },
  font: (px: number, weight?: number) => string,
): void {
  ctx.fillStyle = COL.panel;
  roundRect(ctx, box.x, box.y, box.w, box.h, 14);
  ctx.fill();

  // Body outline (top view): nose up, tail down.
  const cx = box.x + box.w / 2;
  ctx.strokeStyle = "#c2cdd8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, box.y + box.h / 2, box.w * 0.16, box.h * 0.34, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = COL.sub;
  ctx.font = font(16, 600);
  ctx.fillText("앞 (front)", cx - 36, box.y + 12);
  ctx.fillText("뒤 (hind)", cx - 36, box.y + box.h - 28);

  const positions: Record<PawLabel, [number, number]> = {
    LF: [box.x + box.w * 0.26, box.y + box.h * 0.3],
    RF: [box.x + box.w * 0.74, box.y + box.h * 0.3],
    LH: [box.x + box.w * 0.26, box.y + box.h * 0.72],
    RH: [box.x + box.w * 0.74, box.y + box.h * 0.72],
  };
  const order: PawLabel[] = ["LF", "RF", "LH", "RH"];
  const detected = new Set(s.detectedPaws);
  for (const lbl of order) {
    const [px, py] = positions[lbl];
    const load = s.loadPct[lbl];
    const radius = 16 + Math.sqrt(Math.max(0, load)) * 5.5;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = detected.has(lbl) ? COL.pawOn : COL.pawOff;
    ctx.globalAlpha = detected.has(lbl) ? 0.85 : 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    ctx.font = font(16, 700);
    ctx.textAlign = "center";
    ctx.fillText(lbl, px, py - 9);
    ctx.font = font(15, 600);
    ctx.fillText(num(load, 0, "%"), px, py + 6);
    ctx.textAlign = "left";
  }
}

function drawPawTable(
  ctx: CanvasRenderingContext2D,
  paws: GaitPawRow[],
  x: number,
  yy: number,
  w: number,
  font: (px: number, weight?: number) => string,
): number {
  const headers = ["발", "검출", "하중%", "최대압", "충격량", "접지면적", "접지(s)", "스텝"];
  const widths = [0.1, 0.1, 0.12, 0.13, 0.15, 0.15, 0.13, 0.12].map((f) => f * w);
  const rowH = 40;

  // Header row
  ctx.fillStyle = COL.panel;
  roundRect(ctx, x, yy, w, rowH, 8);
  ctx.fill();
  ctx.fillStyle = COL.sub;
  ctx.font = font(18, 700);
  let hx = x + 14;
  for (let i = 0; i < headers.length; i++) {
    ctx.fillText(headers[i], hx, yy + 11);
    hx += widths[i];
  }
  let ry = yy + rowH;

  for (const p of paws) {
    const cells = [
      p.label,
      p.detected ? "✓" : "–",
      num(p.loadPct, 0),
      num(p.peakPressure, 0),
      num(p.pressureImpulse, 0),
      num(p.contactArea, 1),
      num(p.contactTimeSec, 2),
      `${p.stepCount}`,
    ];
    ctx.fillStyle = p.detected ? COL.ink : COL.sub;
    ctx.font = font(19, p.detected ? 600 : 400);
    let cxp = x + 14;
    for (let i = 0; i < cells.length; i++) {
      ctx.fillText(cells[i], cxp, ry + 10);
      cxp += widths[i];
    }
    hline(ctx, x, ry + rowH, x + w);
    ry += rowH;
  }
  return ry;
}

/** Wrap text to width; returns the y after the last line. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  yy: number,
  maxW: number,
  lineH: number,
): number {
  const words = text.split(/(\s+)/);
  let line = "";
  let cy = yy;
  for (const word of words) {
    const test = line + word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, cy);
      line = word.trimStart();
      cy += lineH;
    } else {
      line = test;
    }
  }
  if (line) {
    ctx.fillText(line, x, cy);
    cy += lineH;
  }
  return cy;
}
