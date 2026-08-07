import assert from "node:assert/strict";
import { test } from "node:test";

import { jpegToPdf } from "../src/export/jpegPdf.js";

const dec = (b: Uint8Array): string => Buffer.from(b).toString("latin1");

test("jpegToPdf: produces a structurally valid one-page PDF", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const pdf = jpegToPdf(jpeg, 800, 1200);
  const text = dec(pdf);

  assert.ok(text.startsWith("%PDF-1.4"), "starts with PDF header");
  assert.ok(text.includes("/Type /Catalog"), "has catalog");
  assert.ok(text.includes("/DCTDecode"), "embeds image via DCTDecode");
  assert.ok(text.includes("/Width 800") && text.includes("/Height 1200"), "carries image dims");
  assert.ok(text.includes("startxref"), "has xref");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "ends with EOF");
});

test("jpegToPdf: embeds the JPEG bytes verbatim", () => {
  const jpeg = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
  const pdf = jpegToPdf(jpeg, 100, 100);
  // Find the image stream and confirm the bytes survive unmodified.
  const marker = Buffer.from("stream\n", "latin1");
  let found = -1;
  for (let i = 0; i + jpeg.length <= pdf.length; i++) {
    let ok = true;
    for (let k = 0; k < jpeg.length; k++) {
      if (pdf[i + k] !== jpeg[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      found = i;
      break;
    }
  }
  assert.ok(found > 0, "jpeg bytes present verbatim");
  void marker;
});

test("jpegToPdf: xref offsets point at object headers", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = jpegToPdf(jpeg, 10, 10);
  const text = dec(pdf);

  // Parse the xref table offsets and confirm each points at "<n> 0 obj".
  // (Match the real table, not the "startxref" keyword that also contains "xref".)
  const xrefIdx = text.indexOf("\nxref\n");
  const body = text.slice(xrefIdx);
  const entryRe = /^(\d{10}) 00000 n $/gm;
  let m: RegExpExecArray | null;
  let objNum = 1;
  let checked = 0;
  while ((m = entryRe.exec(body))) {
    const off = parseInt(m[1], 10);
    assert.ok(text.startsWith(`${objNum} 0 obj`, off), `obj ${objNum} at offset ${off}`);
    objNum++;
    checked++;
  }
  assert.equal(checked, 5, "five objects in xref");
});
