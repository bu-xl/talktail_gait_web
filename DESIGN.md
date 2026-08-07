---
name: 보행 분석 (GaitPressureMat)
description: A warm, light clinical instrument for canine gait & pressure analysis at the point of care.
colors:
  primary: "#F0663F"
  primary-pressed: "#D9502B"
  primary-hover: "#F2764D"
  primary-light: "#FDEBE4"
  bg: "#F8F9FB"
  surface: "#FFFFFF"
  surface-hover: "#F0F1F4"
  border: "#D8DCE2"
  border-strong: "#C6CBD2"
  divider: "#E6E9ED"
  text: "#1F2329"
  text-secondary: "#737A86"
  success: "#1A7F37"
  warning: "#9A6700"
  danger: "#CF222E"
  paw-lf: "#3C82F6"
  paw-rf: "#EB463C"
  paw-lh: "#28C8DC"
  paw-rh: "#FF9628"
  paw-unknown: "#A5AAB2"
  mat-frame: "#05070A"
  heat-1: "#283CC8"
  heat-2: "#00AADC"
  heat-3: "#28C85A"
  heat-4: "#F0DC28"
  heat-5: "#F5961E"
  heat-6: "#DC1E1E"
typography:
  title:
    fontFamily: "Pretendard, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Pretendard, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  metric:
    fontFamily: "Pretendard, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
    fontFeature: "'tnum' 1"
  label:
    fontFamily: "Pretendard, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.04em"
  caption:
    fontFamily: "Pretendard, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  chip: "3px"
  sm: "6px"
  md: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "18px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.surface}"
  button-primary-active:
    backgroundColor: "{colors.primary-pressed}"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  input-number:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "7px 8px"
  badge-valid:
    backgroundColor: "{colors.success}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
---

<!-- SEED (chrome color + type layer only): the light coral world below is the confirmed
     brand direction, established with the user. The current code (index.html) still
     implements a legacy GitHub-dark chrome; migrate it to these tokens, then re-run
     /impeccable document to capture the implemented values. Structure, layout, radius,
     spacing, and component anatomy ARE extracted from the incumbent code and are normative
     now. The data-visualization colors (heatmap LUT, paw labels, mat frame) are already
     implemented and are permanent regardless of theme. -->

# Design System: 보행 분석 (GaitPressureMat)

## Overview

**Creative North Star: "The Clinic Companion"**

This is a warm clinical instrument, not a developer console. It sits on a vet's
bench beside the animal and turns a short walk into numbers a clinician trusts —
so it must feel calm, legible, and *certain*. The world is light: a soft
off-white field (`#F8F9FB`) with panels delineated by line, not by heavy fills, and
a single confident coral (`#F0663F`) that carries every primary action and moment of
progress. Coral is TalkTail's warmth made functional; against the quiet neutrals it
reads as "press here, this matters." The character is **tactile and confident** —
solid controls, honest contrast, nothing timid or decorative.

The one place the light world yields is the measurement itself. The pressure mat
sits in a near-black frame (`#05070A`) so the scientific heatmap and paw-label colors
read at full saturation — the reading is the hero, and dark is the correct backdrop
for luminous data. This is a deliberate, permanent exception, not an inconsistency.

Honesty is a visual value here as much as a product one: the UI never dresses up an
uncalibrated reading, never re-tints scientific data, and states confidence plainly
(a solid `LF` vs. a faint `R~F`). The design's job is to get out of the way of a
trustworthy measurement while staying warm enough to work beside all day.

**Key Characteristics:**
- Light, line-delineated instrument surface — panels separated by borders, not fills
- One coral voice for all primary intent; neutrals do the rest
- A dark measurement stage where scientific color lives untouched
- Dense but calm: bilingual (한국어 / English), point-of-care legible
- Tactile, confident controls; no ornament, no drama

## Colors

A quiet neutral field, one warm coral voice, and a fixed scientific spectrum that
never bends to the theme.

### Primary
- **Signal Coral** (`#F0663F`): The single brand action color. Primary buttons (Analyze gait), the active/selected state, focus accents. Warm, confident, used sparingly so it always means "act."
- **Deep Coral / Pressed** (`#D9502B`): The pressed/active depth of Signal Coral. `:active` on primary controls.
- **Coral Hover** (`#F2764D`): A half-step lighter lift on `:hover` of primary controls. *(Derived; adjust against the real primary in implementation.)*
- **Coral Wash** (`#FDEBE4`): The faint coral tint. Focus glow / ring, selected-row wash, subtle highlight fills. Never for text.

### Neutral
- **Ink** (`#1F2329`): Primary text, metric values, headings. Near-black, never pure `#000`.
- **Slate** (`#737A86`): Secondary text — labels, captions, muted stats, section headers, disabled hints.
- **Paper Field** (`#F8F9FB`): The app background and panel surface. Panels share this tone with the page; separation comes from line, not fill.
- **Card White** (`#FFFFFF`): Inputs, and any surface that must read as raised/solid against Paper Field.
- **Field Hover** (`#F0F1F4`): The faint gray a secondary button fills to on `:hover`.
- **Hairline** (`#D8DCE2`): The primary border — panel edges, input strokes, control outlines. The darker "confident" hairline the user chose.
- **Hairline Strong** (`#C6CBD2`): The border a control's Hairline deepens to on `:hover`.
- **Whisper Divider** (`#E6E9ED`): The lighter internal divider between stat rows and table rows.

### Status
- **Valid Green** (`#1A7F37`): VALID trial badge, calibrated/OK status text.
- **Caution Amber** (`#9A6700`): PARTIAL trial, "uncalibrated"/warning status.
- **Alert Red** (`#CF222E`): INVALID trial, error/bad status.

### Data Visualization (permanent — never re-themed)
- **Heatmap spectrum** (fixed LUT, colorbar `[10, 80]`): `#283CC8` → `#00AADC` → `#28C85A` → `#F0DC28` → `#F5961E` → `#DC1E1E`. Blue (low) to red (high). Cells `<10` are fully transparent.
- **Paw labels**: LF `#3C82F6` · RF `#EB463C` · LH `#28C8DC` · RH `#FF9628` · unknown `#A5AAB2`.
- **Mat frame** (`#05070A`): The dark stage behind the heatmap.

### Named Rules
**The One Coral Rule.** Signal Coral is the only brand accent, and it appears on the primary action and active state — nowhere else. If more than a couple of coral elements share a screen, one of them is not really the primary action.

**The Untouched-Data Rule.** Heatmap and paw-label colors are scientific truth. Never recolor them to match the brand, never autoscale them per frame, never apply coral to a reading. The measurement owns its own palette.

**The Line-Not-Fill Rule.** Depth on the chrome comes from `#D8DCE2` hairlines and `#E6E9ED` dividers, not from stacked gray fills or shadows. When you need to separate two regions, reach for a border first.

## Typography

**Body / UI Font:** Pretendard (with `system-ui, sans-serif` fallback)

**Character:** Pretendard carries Korean and English with equal clarity at small sizes — essential for this bilingual, data-dense tool. The type is functional and even-toned; hierarchy comes from weight and color, not from display flourish. There is no display tier — this is an instrument, not a page.

### Hierarchy
- **Title** (600, 15px, 1.3): The app title (`보행 분석`) and the strongest headings. The largest type in the product.
- **Metric** (600, 14px, 1.4, tabular figures): The bold values in stat rows and the gait table (`Max pressure`, `Load%`, `Peak`). Tabular numerals so columns of numbers align and don't jitter as they update live.
- **Body** (400, 14px, 1.4): Default UI text, button labels, row labels.
- **Label** (600, 12px, 0.04em, UPPERCASE): Section headers (RECORDING, GAIT ANALYSIS, PAW LABELS). Slate color, tracked out.
- **Caption** (400, 12px, 1.5): Table cells, legends, summary notes, muted secondary text.

### Named Rules
**The Tabular Metric Rule.** Every number that updates live or sits in a column uses tabular figures (`font-feature-settings: 'tnum'`). A clinician's eye should never chase a digit that shifted because a `1` is narrower than an `8`.

## Layout

A fixed two-pane app shell filling the viewport (`100vh`), and it does not scroll as a page — each pane manages its own space.

- **Stage (left, flexible):** Centers the pressure mat. The mat holds a strict `aspect-ratio: 73 / 168` (**1 : 2.3014 — never square**), sized to ~92% of viewport height, framed in the dark `#05070A` well with an 8px radius. The heatmap and the transparent paw-overlay canvas share this exact box.
- **Console (right, fixed 280px):** The control-and-readout sidebar. Scrolls internally when content overflows. Paper Field surface, `18px` padding, a vertical stack with `14px` rhythm between groups.

Inside the console, controls are laid out on a **two-column grid** (`grid-template-columns: 1fr 1fr`, `8px` gap); a primary action spans both columns. Stat and result rows are full-width `space-between` pairs (label left, value right) divided by `#E6E9ED` hairlines.

Spacing rhythm: `4 / 8 / 14 / 18px`. Row padding is `6px` vertical.

## Elevation & Depth

**Flat by default; depth is drawn, not lit.** The chrome uses no drop shadows. Separation is achieved entirely through the `#D8DCE2` border / `#E6E9ED` divider system and, occasionally, the `#FFFFFF` card surface lifting off the `#F8F9FB` field. The only "elevation" in the product is the dark mat well, which recedes visually so the luminous heatmap advances.

### Named Rules
**The No-Shadow Rule.** Chrome surfaces cast no shadow at rest or on hover. If something needs to feel raised, change its surface to Card White and give it a Hairline border — do not add a shadow.

## Shapes

Gently rounded, quiet geometry. A tight radius set:
- **3px (chip)** — the tiny data-viz swatches in the paw legend only.
- **6px (sm)** — the workhorse: buttons, inputs, the legend/colorbar, selects. Every interactive control.
- **8px (md)** — containers: the mat well.
- **999px (pill)** — status badges (VALID / PARTIAL / INVALID) only.

Borders are always `1px`. No thick strokes, no sharp corners, no heavy outlines — the form language stays soft and even, letting color and type carry emphasis.

## Components

Lead feel: **tactile and confident** — solid fills, honest borders, unambiguous states.

### Buttons
- **Shape:** 6px radius, `1px` border, `8px 10px` padding, centered label.
- **Secondary (default):** Card White (`#FFFFFF`) surface, Ink text, Hairline (`#D8DCE2`) border. Hover: surface shifts to a faint gray (`#F0F1F4`). This is the workhorse control (Connect, Calibrate, Grid, exports).
- **Primary:** Signal Coral (`#F0663F`) fill, white text, coral border; spans both grid columns (Analyze gait). Hover: `#F2764D`. Active: `#D9502B`.
- **Active/Toggle-on:** Signal Coral fill + white text (e.g. Labels: On, Sharpness). The coral state signals "engaged."
- **Disabled:** `opacity: 0.4`, `not-allowed` cursor. Used heavily — export/analyze buttons stay disabled until their data exists. Disabled state must always read clearly, since the flow gates on it.

### Inputs / Fields
- **Style:** Card White surface, Hairline (`#D8DCE2`) border, 6px radius, `7px 8px` padding, inherits body type. The dog-weight number field and the language select.
- **Focus:** Coral (`#F0663F`) border with a Coral Wash (`#FDEBE4`) ring/glow. Focus is the one place chrome borrows the accent.

### Rows (stat & result)
- **Style:** Full-width `space-between`; label in Slate/Body, value in Ink/Metric (bold, tabular). Separated by `#E6E9ED` dividers, `6px` vertical padding.
- **Status values** take semantic color: `success` / `warning` / `danger` / Slate-for-idle.

### Badges (trial validity)
- **Style:** Pill (999px), `3px 10px`, 600/12px, white text on a solid status fill — VALID `#1A7F37`, PARTIAL `#9A6700`, INVALID `#CF222E`.

### Section Header
- **Style:** Label type — 12px, 600, UPPERCASE, `0.04em` tracking, Slate color. Introduces each console group with `4px` top margin.

### Legend / Colorbar (signature)
- The fixed heatmap gradient rendered as a `12px`-tall, 6px-radius bar between its `10` and `80` bounds. It is a legend, not a control — it must always show the *fixed* spectrum so the color scale never lies.

### Paw Legend (signature)
- A wrapped row of `11px` rounded (3px) color chips + label: LF / RF / LH / RH / ?, in their permanent data-viz colors. Caption type, Slate labels.

## Do's and Don'ts

### Do:
- **Do** keep one coral voice — Signal Coral (`#F0663F`) marks the primary action and the active state, and little else.
- **Do** separate chrome regions with `#D8DCE2` hairlines and `#E6E9ED` dividers rather than shadows or stacked fills.
- **Do** set every live/columnar number in tabular figures so digits never jitter.
- **Do** keep the pressure mat in its dark `#05070A` well; the reading is the hero and needs the dark backdrop.
- **Do** hold the mat at `1 : 2.3014` (73 × 168) — derive height from width. **Never square.**
- **Do** render Korean and English at equal quality (Pretendard); the language toggle is permanent.
- **Do** make disabled states unmistakable — the Calibrate → Record → Weight → Analyze flow gates on them.

### Don't:
- **Don't** recolor, re-tint, or per-frame autoscale the heatmap or paw-label colors — they are scientific truth.
- **Don't** add drop shadows to chrome surfaces; depth is drawn with line and surface, not light.
- **Don't** introduce a second accent color to compete with coral.
- **Don't** apply coral to a data reading or use it to imply a measurement value.
- **Don't** carry the legacy GitHub-dark chrome (`#0e1117` / `#161b22` / `#1f6feb`) forward — it is the anti-reference this world replaces.
- **Don't** use pure black (`#000`) or pure-saturated grays; stay in the Ink / Slate / Paper family.
