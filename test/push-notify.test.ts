/**
 * The desktop notification channel: which escape sequence a terminal gets, and
 * that nothing the loop puts in a message can break out of it. Subprocess
 * calls are captured so tests never display a desktop notification.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { notificationSequence, pushNotify, type PushNotifyDeps } from "../src/util/push-notify.ts";

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

test("Windows notifications use a fixed executable and escape every apostrophe", () => {
  const calls: unknown[][] = [];
  const execFile: PushNotifyDeps["execFile"] = (...args) => { calls.push(args); };
  pushNotify("operator's 'title'", "loop's 'halt'", { WT_SESSION: "abc" }, { execFile });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const args = calls[0][1] as string[];
  assert.deepEqual(args.slice(0, 2), ["-NoProfile", "-Command"]);
  assert.ok(args[2].includes("operator''s ''title''"));
  assert.ok(args[2].includes("loop''s ''halt''"));
});

test("a notification spawn failure never reaches the caller", () => {
  assert.doesNotThrow(() => pushNotify("specs-kit", "halt", { WT_SESSION: "abc" }, {
    execFile: () => { throw new Error("unavailable"); },
  }));
});

test("the delimiter and the control characters never survive into the sequence", () => {
  // A halt detail carries whatever the failing phase printed; a semicolon in it
  // would end the title early and the rest would be read as the terminal's own
  // parameters.
  const seq = notificationSequence("specs-kit", "Loop halted: boom;notify;evil\x07\nrest", {});
  assert.ok(seq !== null);
  assert.equal(seq, "\x1b]777;notify;specs-kit;Loop halted: boom notify evil  rest\x07");
});
