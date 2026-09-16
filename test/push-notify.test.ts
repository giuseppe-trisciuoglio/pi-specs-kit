/**
 * The desktop notification channel: which escape sequence a terminal gets, and
 * that nothing the loop puts in a message can break out of it. The write
 * itself is not exercised — the sequence is the whole contract.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { notificationSequence } from "../src/util/push-notify.ts";

test("an ordinary terminal gets the OSC 777 sequence", () => {
  const seq = notificationSequence("specs-kit", "Loop halted", {});
  assert.equal(seq, "\x1b]777;notify;specs-kit;Loop halted\x07");
});

test("Kitty gets its own two-part sequence", () => {
  const seq = notificationSequence("specs-kit", "Loop halted", { KITTY_WINDOW_ID: "1" });
  assert.ok(seq !== null);
  assert.match(seq, /^\x1b\]99;i=1:d=0;specs-kit\x1b\\/);
  assert.match(seq, /\x1b\]99;i=1:p=body;Loop halted\x1b\\$/);
});

test("Windows Terminal takes the subprocess path instead of a sequence", () => {
  assert.equal(notificationSequence("specs-kit", "Loop halted", { WT_SESSION: "abc" }), null);
});

test("the delimiter and the control characters never survive into the sequence", () => {
  // A halt detail carries whatever the failing phase printed; a semicolon in it
  // would end the title early and the rest would be read as the terminal's own
  // parameters.
  const seq = notificationSequence("specs-kit", "Loop halted: boom;notify;evil\x07\nrest", {});
  assert.ok(seq !== null);
  assert.equal(seq, "\x1b]777;notify;specs-kit;Loop halted: boom notify evil  rest\x07");
});
