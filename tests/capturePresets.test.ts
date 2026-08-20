import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPTURE_PRESETS,
  DEFAULT_CAPTURE_PRESET_ID,
  captureSettingsPayload,
  presetById,
} from "../src/capture/presets.js";

test("default capture preset is 1080p 30fps", () => {
  assert.equal(DEFAULT_CAPTURE_PRESET_ID, "1080p30");
  assert.equal(presetById(undefined).id, "1080p30");
});

test("capture presets include the clinic menu", () => {
  const ids = CAPTURE_PRESETS.map((p) => p.id);
  for (const id of ["720p30", "720p60", "1080p30", "1080p60", "2k30", "4k24", "4k30", "4k60"]) {
    assert.ok(ids.includes(id), id);
  }
});

test("capture settings payload mirrors the preset", () => {
  const preset = presetById("4k30");
  assert.deepEqual(captureSettingsPayload(preset), {
    presetId: "4k30",
    videoQuality: "2160p",
    fps: 30,
    width: 3840,
    height: 2160,
    bitrate: 40_000_000,
  });
});
