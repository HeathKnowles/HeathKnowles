const fs = require("node:fs/promises");

const SVG_PATH = "assets/portfolio.svg";
const API_URL = "https://api.github.com/graphql";
const DAY_MS = 86_400_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function graphqlRequest(query, variables, token) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "github-stats-updater",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(
          `GitHub GraphQL request failed (${response.status}): ${errorText}`,
        );
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      const payload = await response.json();
      if (payload.errors?.length) {
        const error = new Error(
          `GitHub GraphQL errors: ${JSON.stringify(payload.errors)}`,
        );
        error.retryable = false;
        throw error;
      }

      return payload.data;
    } catch (error) {
      lastError = error;
      // Retry network failures and transient HTTP errors, never GraphQL errors.
      const retryable = error.retryable ?? true;
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

// Adds whole years in UTC, clamping Feb 29 to Feb 28 in non-leap years.
function addYears(date, years) {
  const target = new Date(date.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCFullYear(target.getUTCFullYear() + years);
  const lastDayOfMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfMonth));
  return target;
}

// Splits a date range into chunks of at most 1 year (the GraphQL API limit).
// Each `to` is 1ms before the next `from`, so a boundary contribution can
// never be counted in two chunks.
function buildYearlyRanges(from, to) {
  const ranges = [];
  let start = new Date(from);
  const end = new Date(to);

  while (start < end) {
    const next = addYears(start, 1);
    const chunkEnd = next < end ? next : end;
    ranges.push({
      from: start.toISOString(),
      to: new Date(chunkEnd.getTime() - 1).toISOString(),
    });
    start = chunkEnd;
  }

  return ranges;
}

// Contribution calendars are week-aligned, so neighbouring chunks can return
// the same date more than once (often with a 0 count for days outside the
// chunk's range). Keep the highest count per date and sort oldest-first.
function mergeContributionDays(days) {
  const byDate = new Map();

  for (const day of days) {
    const existing = byDate.get(day.date);
    if (!existing || day.contributionCount > existing.contributionCount) {
      byDate.set(day.date, day);
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function toDayNumber(date) {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

// Streaks are counted over consecutive calendar days, not over consecutive
// array entries, so gaps or duplicated dates cannot inflate them.
function calculateStreaks(days, today = todayUtcDate()) {
  const activeDays = days
    .filter((day) => day.contributionCount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  let longest = 0;
  let run = 0;
  let previousDay = null;

  for (const day of activeDays) {
    const dayNumber = toDayNumber(day.date);
    run = previousDay !== null && dayNumber === previousDay + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previousDay = dayNumber;
  }

  if (activeDays.length === 0) {
    return { current: 0, longest: 0 };
  }

  const todayNumber = toDayNumber(today);
  const lastActiveDay = toDayNumber(activeDays[activeDays.length - 1].date);

  // A streak is still current if the last contribution was today or yesterday
  // (the user may simply not have committed yet today).
  if (todayNumber - lastActiveDay > 1) {
    return { current: 0, longest };
  }

  let current = 1;
  for (let i = activeDays.length - 1; i > 0; i -= 1) {
    const later = toDayNumber(activeDays[i].date);
    const earlier = toDayNumber(activeDays[i - 1].date);
    if (later - earlier !== 1) break;
    current += 1;
  }

  return { current, longest };
}

function replaceStatValue(svg, id, value) {
  const pattern = new RegExp(`(<text id="${id}"[^>]*>)([^<]*)(</text>)`);
  if (!pattern.test(svg)) {
    throw new Error(`Could not find SVG node with id="${id}"`);
  }
  return svg.replace(pattern, `$1${value}$3`);
}

async function main() {
  // A classic PAT with `read:user` is enough for public contributions; add
  // `repo` to include private contributions. The default GITHUB_TOKEN is an
  // installation token and cannot see the user's full contribution graph.
  const token = process.env.GH_PAT;
  const username =
    process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER;

  if (!token) {
    throw new Error(
      "GH_PAT is required (classic PAT with read:user, plus repo for private contributions)",
    );
  }
  if (!username)
    throw new Error("GITHUB_USERNAME or GITHUB_REPOSITORY_OWNER is required");

  // 1. Fetch the account creation date
  const userQuery = `
    query($login: String!) {
      user(login: $login) {
        createdAt
      }
    }
  `;
  const userData = await graphqlRequest(userQuery, { login: username }, token);
  const createdAt = userData.user?.createdAt;
  if (!createdAt)
    throw new Error(`Could not resolve GitHub user "${username}"`);

  // 2. Build yearly ranges so we never exceed the 1-year API limit
  const today = todayUtcDate();
  const ranges = buildYearlyRanges(createdAt, new Date().toISOString());

  const statsQuery = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  // 3. Fetch each chunk and accumulate results
  let totalCommits = 0;
  const allDays = [];

  for (const range of ranges) {
    const data = await graphqlRequest(
      statsQuery,
      { login: username, from: range.from, to: range.to },
      token,
    );

    const collection = data.user?.contributionsCollection;
    if (!collection) {
      throw new Error(
        `Could not load contribution data for "${username}" (range: ${range.from})`,
      );
    }

    totalCommits += collection.totalCommitContributions;
    const chunkDays = collection.contributionCalendar.weeks.flatMap(
      (w) => w.contributionDays,
    );
    allDays.push(...chunkDays);
  }

  // 4. Dedupe boundary days, drop future/pre-account days, then compute streaks
  const firstDate = createdAt.slice(0, 10);
  const days = mergeContributionDays(allDays).filter(
    (day) => day.date >= firstDate && day.date <= today,
  );

  const { current, longest } = calculateStreaks(days, today);
  const formattedCommits = new Intl.NumberFormat("en-US").format(totalCommits);

  // 5. Write stats into the SVG
  let svg = await fs.readFile(SVG_PATH, "utf8");
  svg = replaceStatValue(svg, "stats-commits", formattedCommits);
  svg = replaceStatValue(svg, "stats-streak", String(current));
  svg = replaceStatValue(svg, "stats-longest-streak", String(longest));
  await fs.writeFile(SVG_PATH, svg, "utf8");

  console.log(
    `Updated stats for ${username}: commits=${formattedCommits}, streak=${current}, longest=${longest}`,
  );
}

module.exports = {
  buildYearlyRanges,
  calculateStreaks,
  mergeContributionDays,
  replaceStatValue,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
