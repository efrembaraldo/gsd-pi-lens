#!/usr/bin/env node
import { readFileSync } from "node:fs";

const EXPECTED = {
  clients: 443,
  "clients/dispatch": 27,
  "clients/dispatch/runners": 82,
  "clients/lsp": 44,
};

const baseline = JSON.parse(
  readFileSync("tests/config/strictness-baseline.json", "utf8"),
);

const indexed = baseline["tsconfig.strict-indexed.json"];
if (!indexed) {
  console.error(
    "FAIL: tsconfig.strict-indexed.json entry not found in strictness-baseline.json",
  );
  process.exit(1);
}

let mismatch = null;
for (const [key, expected] of Object.entries(EXPECTED)) {
  if (indexed[key] !== expected) {
    mismatch = { key, expected, actual: indexed[key] };
    break;
  }
}

if (mismatch) {
  console.error(
    `FAIL: tsconfig.strict-indexed.json.${mismatch.key} = ${mismatch.actual}, expected ${mismatch.expected}`,
  );
  process.exit(1);
}

console.log(
  "OK: M004/S01 strictness baseline matches upstream post-merge counts.",
);
