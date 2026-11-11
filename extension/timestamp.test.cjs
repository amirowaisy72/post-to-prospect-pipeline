// Tests for the timestamp capture in structured.js:
// exact description first, label-minus-now fallback second.
//
// structured.js is a classic browser script (not a module), so this
// test copies it to a temp .cjs file and requires that — byte-identical
// code, just a different extension so Node treats it as CommonJS.
// Run: node --test extension/timestamp.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpFile = path.join(os.tmpdir(), `structured-under-test-${process.pid}.cjs`);
fs.copyFileSync(path.join(__dirname, "structured.js"), tmpFile);
const { postedAtFromLabel, parseExactTimestamp, isTimestampLabel } = require(tmpFile);

// Fixed collection instant: 2026-11-12 12:00 local time.
const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

test("postedAtFromLabel: '5d' at a fixed now is now minus 5 days", () => {
  assert.equal(postedAtFromLabel("5d", NOW), iso(NOW - 5 * 86400000));
});

test("postedAtFromLabel: hours, minutes, weeks and seconds", () => {
  assert.equal(postedAtFromLabel("5h", NOW), iso(NOW - 5 * 3600000));
  assert.equal(postedAtFromLabel("5m", NOW), iso(NOW - 5 * 60000));
  assert.equal(postedAtFromLabel("5w", NOW), iso(NOW - 5 * 604800000));
  assert.equal(postedAtFromLabel("5s", NOW), iso(NOW - 5 * 1000));
});

test("postedAtFromLabel: long forms, Yesterday and Just now", () => {
  assert.equal(postedAtFromLabel("3 days ago", NOW), iso(NOW - 3 * 86400000));
  assert.equal(postedAtFromLabel("2 hours ago", NOW), iso(NOW - 2 * 3600000));
  assert.equal(postedAtFromLabel("Yesterday", NOW), iso(NOW - 86400000));
  assert.equal(postedAtFromLabel("Just now", NOW), iso(NOW));
});

test("postedAtFromLabel: unparseable labels return null", () => {
  assert.equal(postedAtFromLabel("October 12", NOW), null);
  assert.equal(postedAtFromLabel("", NOW), null);
  assert.equal(postedAtFromLabel(null, NOW), null);
});

test("parseExactTimestamp: full description with weekday (live shape)", () => {
  // Visible "5d" -> description "Friday 6 November 2026 at 09:10".
  assert.equal(
    parseExactTimestamp("Friday 6 November 2026 at 09:10", NOW),
    new Date(2026, 10, 6, 9, 10).toISOString(),
  );
  // Visible "19h" -> "Wednesday 11 November 2026 at 05:43".
  assert.equal(
    parseExactTimestamp("Wednesday 11 November 2026 at 05:43", NOW),
    new Date(2026, 10, 11, 5, 43).toISOString(),
  );
});

test("parseExactTimestamp: no-year form uses the current year", () => {
  // Post header shows "5 November at 21:02".
  assert.equal(
    parseExactTimestamp("5 November at 21:02", NOW),
    new Date(2026, 10, 5, 21, 2).toISOString(),
  );
});

test("parseExactTimestamp: Yesterday / Today at HH:MM", () => {
  assert.equal(
    parseExactTimestamp("Yesterday at 21:02", NOW),
    new Date(2026, 10, 11, 21, 2).toISOString(),
  );
  assert.equal(
    parseExactTimestamp("Today at 09:10", NOW),
    new Date(2026, 10, 12, 9, 10).toISOString(),
  );
});

test("parseExactTimestamp: garbage returns null", () => {
  assert.equal(parseExactTimestamp("not a date", NOW), null);
  assert.equal(parseExactTimestamp("", NOW), null);
});

test("isTimestampLabel recognises the label forms", () => {
  for (const label of ["5d", "19h", "5m", "5w", "5s", "5 days ago", "Yesterday", "Just now", "5 November at 21:02"]) {
    assert.equal(isTimestampLabel(label), true, label);
  }
  assert.equal(isTimestampLabel("Keep it for long term"), false);
  assert.equal(isTimestampLabel(""), false);
});
