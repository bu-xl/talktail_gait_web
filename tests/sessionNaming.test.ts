import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dogPrefix,
  formatWeightTag,
  parseCaptureName,
  pressureCsvName,
  sanitizeDogName,
  stampFrom,
  videoBaseName,
} from "../src/core/sessionNaming.js";

const DOG = { name: "대박이", weightKg: 5.2 };
const STAMP = "260819-144204";

test("the documented example round-trips exactly", () => {
  assert.equal(
    videoBaseName({ dog: DOG, role: "main", stamp: STAMP }),
    "대박이-5.2kg-main-260819-144204",
  );
  assert.equal(
    videoBaseName({ dog: DOG, role: "sub", subIndex: 1, stamp: STAMP }),
    "대박이-5.2kg-sub1-260819-144204",
  );
  assert.equal(
    videoBaseName({ dog: DOG, role: "sub", subIndex: 2, stamp: STAMP }),
    "대박이-5.2kg-sub2-260819-144204",
  );
  assert.equal(pressureCsvName({ dog: DOG, stamp: STAMP }), "대박이-5.2kg-260819-144204.csv");
});

test("weight drops trailing zeros but keeps real decimals", () => {
  assert.equal(formatWeightTag(5.2), "5.2kg");
  assert.equal(formatWeightTag(5), "5kg");
  assert.equal(formatWeightTag(5.0), "5kg");
  assert.equal(formatWeightTag(12.75), "12.75kg");
  assert.equal(formatWeightTag(5.239), "5.24kg", "rounds to 2 decimals");
});

test("an unusable weight is left out instead of printing zero", () => {
  assert.equal(formatWeightTag(0), "");
  assert.equal(formatWeightTag(-3), "");
  assert.equal(formatWeightTag(null), "");
  assert.equal(formatWeightTag(undefined), "");
  assert.equal(formatWeightTag(Number.NaN), "");
  assert.equal(dogPrefix({ name: "대박이", weightKg: null }), "대박이");
});

test("names that would break a filesystem are cleaned, not rejected", () => {
  assert.equal(sanitizeDogName("a/b"), "ab");
  assert.equal(sanitizeDogName("a\\b:c*d?e\"f<g>h|i"), "abcdefghi");
  assert.equal(sanitizeDogName("  뭉치  "), "뭉치");
  assert.equal(sanitizeDogName("초코 라떼"), "초코_라떼", "spaces become underscores");
  assert.equal(sanitizeDogName("..hidden"), "hidden", "a leading dot would hide the file");
  assert.equal(sanitizeDogName("trailing."), "trailing", "a trailing dot breaks on Windows");
});

test("hyphens are stripped from names so the separator stays unambiguous", () => {
  assert.equal(sanitizeDogName("대-박-이"), "대박이");
  const base = videoBaseName({ dog: { name: "대-박-이", weightKg: 5.2 }, role: "main", stamp: STAMP });
  assert.equal(base, "대박이-5.2kg-main-260819-144204");
  assert.deepEqual(parseCaptureName(`${base}.mp4`), {
    role: "main",
    subIndex: null,
    stamp: STAMP,
    dog: "대박이-5.2kg",
  });
});

test("an unnamed dog falls back to the legacy name", () => {
  assert.equal(sanitizeDogName(""), "");
  assert.equal(sanitizeDogName(null), "");
  assert.equal(sanitizeDogName("///"), "");
  assert.equal(dogPrefix({ name: null, weightKg: 5.2 }), "");
  assert.equal(
    videoBaseName({ dog: { name: null, weightKg: 5.2 }, role: "main", stamp: STAMP }),
    "main-260819-144204",
  );
  assert.equal(
    pressureCsvName({ dog: { name: "", weightKg: null }, stamp: STAMP }),
    "pressure-260819-144204.csv",
  );
});

test("a very long name is truncated so the path stays usable", () => {
  const long = "가".repeat(120);
  assert.equal(sanitizeDogName(long).length, 40);
});

test("the stamp matches the backend's YYMMDD-HHMMSS", () => {
  assert.equal(stampFrom(new Date(2026, 7, 19, 14, 42, 4)), "260819-144204");
  assert.equal(stampFrom(new Date(2026, 0, 2, 3, 4, 5)), "260102-030405", "pads every field");
  assert.match(stampFrom(), /^\d{6}-\d{6}$/);
});

test("parseCaptureName still reads legacy filenames", () => {
  // This is what protects the backend: its file matching anchors on this tail,
  // so files written before the rename keep resolving.
  assert.deepEqual(parseCaptureName("main-260812-143022.mp4"), {
    role: "main",
    subIndex: null,
    stamp: "260812-143022",
    dog: "",
  });
  assert.deepEqual(parseCaptureName("sub2-260812-143022.mp4"), {
    role: "sub",
    subIndex: 2,
    stamp: "260812-143022",
    dog: "",
  });
});

test("parseCaptureName handles the collision suffix the backend appends", () => {
  assert.deepEqual(parseCaptureName("대박이-5.2kg-main-260819-144204-2.mp4"), {
    role: "main",
    subIndex: null,
    stamp: "260819-144204",
    dog: "대박이-5.2kg",
  });
  assert.deepEqual(parseCaptureName("main-260812-143022-3.mp4"), {
    role: "main",
    subIndex: null,
    stamp: "260812-143022",
    dog: "",
  });
});

test("parseCaptureName rejects names that are not capture files", () => {
  assert.equal(parseCaptureName("notes.txt"), null);
  assert.equal(parseCaptureName("main.mp4"), null, "no stamp");
  assert.equal(parseCaptureName("main-2608-1430.mp4"), null, "malformed stamp");
  assert.equal(parseCaptureName(""), null);
});

test("a dog literally named main or sub does not confuse the parser", () => {
  const base = videoBaseName({ dog: { name: "main", weightKg: 4 }, role: "sub", subIndex: 1, stamp: STAMP });
  assert.equal(base, "main-4kg-sub1-260819-144204");
  const parsed = parseCaptureName(`${base}.mp4`);
  assert.ok(parsed);
  assert.equal(parsed.role, "sub", "the trailing role wins, not the name");
  assert.equal(parsed.subIndex, 1);
  assert.equal(parsed.dog, "main-4kg");
});
