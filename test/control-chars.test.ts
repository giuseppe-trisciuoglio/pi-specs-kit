import test from "node:test";
import assert from "node:assert/strict";
import { stripControlChars } from "../src/util/control-chars.ts";

test("stripControlChars removes NUL bytes", () => {
  assert.equal(stripControlChars("Tests run: 3\0\0\0 failures"), "Tests run: 3 failures");
});

test("stripControlChars keeps tab, newline and carriage return", () => {
  assert.equal(stripControlChars("a\tb\nc\r\nd"), "a\tb\nc\r\nd");
});

test("stripControlChars removes the other non-printable controls", () => {
  const noisy = "ok\x01\x07\x0B\x0C\x1B[31m\x7Fend";
  assert.equal(stripControlChars(noisy), "ok[31mend");
});

test("stripControlChars leaves printable and multi-byte text untouched", () => {
  const text = "BUILD FAILURE — 3 errori ✓";
  assert.equal(stripControlChars(text), text);
});
