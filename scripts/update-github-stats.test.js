const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildYearlyRanges,
  calculateStreaks,
  mergeContributionDays,
} = require("./update-github-stats.js");

const day = (date, contributionCount) => ({ date, contributionCount });

test("mergeContributionDays dedupes boundary dates, keeping the highest count", () => {
  const merged = mergeContributionDays([
    day("2026-11-20", 0),
    day("2026-11-20", 3),
    day("2026-11-19", 1),
  ]);

  assert.deepEqual(merged, [day("2026-11-19", 1), day("2026-11-20", 3)]);
});

test("calculateStreaks counts consecutive calendar days", () => {
  const days = [
    day("2026-11-19", 1),
    day("2026-11-20", 2),
    day("2026-11-21", 1),
  ];

  assert.deepEqual(calculateStreaks(days, "2026-11-21"), {
    current: 3,
    longest: 3,
  });
});

test("calculateStreaks breaks on a missing day", () => {
  const days = [
    day("2026-11-18", 1),
    day("2026-11-20", 1),
    day("2026-11-21", 1),
  ];

  assert.deepEqual(calculateStreaks(days, "2026-11-21"), {
    current: 2,
    longest: 2,
  });
});

test("calculateStreaks keeps a streak alive through yesterday", () => {
  const days = [day("2026-11-19", 1), day("2026-11-20", 1)];

  assert.deepEqual(calculateStreaks(days, "2026-11-21"), {
    current: 2,
    longest: 2,
  });
});

test("calculateStreaks resets when the last contribution is older than yesterday", () => {
  const days = [day("2026-11-18", 1), day("2026-11-19", 1)];

  assert.deepEqual(calculateStreaks(days, "2026-11-21"), {
    current: 0,
    longest: 2,
  });
});

test("calculateStreaks ignores zero-contribution days", () => {
  assert.deepEqual(calculateStreaks([day("2026-11-21", 0)], "2026-11-21"), {
    current: 0,
    longest: 0,
  });
});

test("buildYearlyRanges produces non-overlapping chunks", () => {
  const ranges = buildYearlyRanges(
    "2022-06-15T00:00:00.000Z",
    "2025-11-21T00:00:00.000Z",
  );

  assert.equal(ranges.length, 4);
  for (let i = 1; i < ranges.length; i += 1) {
    assert.equal(Date.parse(ranges[i].from), Date.parse(ranges[i - 1].to) + 1);
  }
});

test("buildYearlyRanges clamps leap-day start dates", () => {
  const ranges = buildYearlyRanges(
    "2024-02-29T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
  );

  assert.equal(ranges[1].from.slice(0, 10), "2025-02-28");
});
