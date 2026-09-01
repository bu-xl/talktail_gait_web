import assert from "node:assert/strict";
import { test } from "node:test";

import { checkDogIdentity } from "../src/core/dogIdentity.js";

test("이름·몸무게·견종이 모두 있어야 통과", () => {
  assert.equal(checkDogIdentity({ name: "제니", weightKg: 19.8, breed: "래브라도" }).ok, true);
  for (const dog of [
    { name: " ", weightKg: 19.8, breed: "래브라도" },
    { name: "제니", weightKg: 0, breed: "래브라도" },
    { name: "제니", weightKg: null, breed: "래브라도" },
    { name: "제니", weightKg: 19.8, breed: " " },
    null,
  ]) {
    const gate = checkDogIdentity(dog);
    assert.equal(gate.ok, false);
    assert.equal(gate.reasonKey, "session_need_dog");
  }
});
