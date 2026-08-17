#!/usr/bin/env node
// Pulls the reviewer's JSON answer out of a raw transcript.
//
// Reviewers are told to answer with one JSON object and nothing else, and they mostly do
// — but "mostly" is not a contract: a stray sentence, a code fence or a thinking preamble
// shows up often enough that a brace-counting scan is the difference between a usable
// critique and a lost reviewer. The answer is the last complete object in the text, so we
// collect every balanced candidate and keep the last one that parses.
//
// Usage: extract-json.mjs <raw.txt> <out.json>
// Exit:  0 written, 1 nothing parseable.

import { readFileSync, writeFileSync } from 'node:fs';

const [rawPath, outPath] = process.argv.slice(2);
if (!rawPath || !outPath) {
  process.stderr.write('usage: extract-json.mjs <raw.txt> <out.json>\n');
  process.exit(2);
}

let text;
try {
  text = readFileSync(rawPath, 'utf8');
} catch (err) {
  process.stderr.write(`cannot read ${rawPath}: ${err.message}\n`);
  process.exit(1);
}

// Walks from an opening brace to its match, skipping over string literals so that a brace
// inside a quoted scenario does not close the object early.
function balancedEnd(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

let lastAnswer = null;
let lastObject = null;
for (let i = 0; i < text.length; i += 1) {
  if (text[i] !== '{') continue;
  const end = balancedEnd(text, i);
  if (end === -1) continue;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(i, end + 1));
  } catch {
    continue;
  }
  lastObject = parsed;
  // An object carrying findings or verdicts is the deliverable; anything else is a
  // fragment the model happened to print along the way, kept only as a fallback.
  if (Array.isArray(parsed.findings) || Array.isArray(parsed.verdicts)) lastAnswer = parsed;
  i = end; // objects nested inside this one cannot be the answer
}

const answer = lastAnswer ?? lastObject;
if (!answer) process.exit(1);

// The header travels with the critique: a merge run months later must be able to tell
// which model said what without reconstructing it from the file name.
const document = {
  model: process.env.REVIEWER_MODEL ?? null,
  persona: process.env.REVIEWER_PERSONA ?? null,
  timestamp: new Date().toISOString(),
  exit_status: process.env.REVIEWER_EXIT === undefined ? null : Number(process.env.REVIEWER_EXIT),
  answer,
};

writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
