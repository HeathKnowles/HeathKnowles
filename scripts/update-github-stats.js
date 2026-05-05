const fs = require("node:fs/promises");

const SVG_PATH = "assets/portfolio.svg";
const API_URL = "https://api.github.com/graphql";

async function graphqlRequest(query, variables, token) {
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
    throw new Error(`GitHub GraphQL request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

function calculateStreaks(days) {
  let longest = 0;
  let running = 0;

  for (const day of days) {
    if (day.contributionCount > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  const lastActiveIndex = days.map((d) => d.contributionCount > 0).lastIndexOf(true);
  if (lastActiveIndex === -1) {
    return { current: 0, longest };
  }

  const lastActiveDate = new Date(`${days[lastActiveIndex].date}T00:00:00Z`);
  const todayUtc = new Date();
  const todayDateOnly = new Date(
    Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate())
  );
  const diffDays = Math.floor((todayDateOnly - lastActiveDate) / 86400000);

  if (diffDays > 1) {
    return { current: 0, longest };
  }

  let current = 0;
  for (let i = lastActiveIndex; i >= 0; i -= 1) {
    if (days[i].contributionCount > 0) {
      current += 1;
    } else {
      break;
    }
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
  const token = process.env.GITHUB_TOKEN;
  const username = process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER;

  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }
  if (!username) {
    throw new Error("GITHUB_USERNAME or GITHUB_REPOSITORY_OWNER is required");
  }

  const userQuery = `
    query($login: String!) {
      user(login: $login) {
        createdAt
      }
    }
  `;
  const userData = await graphqlRequest(userQuery, { login: username }, token);
  const createdAt = userData.user?.createdAt;
  if (!createdAt) {
    throw new Error(`Could not resolve GitHub user "${username}"`);
  }

  const now = new Date().toISOString();
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

  const statsData = await graphqlRequest(
    statsQuery,
    { login: username, from: createdAt, to: now },
    token
  );

  const collection = statsData.user?.contributionsCollection;
  if (!collection) {
    throw new Error(`Could not load contribution data for "${username}"`);
  }

  const days = collection.contributionCalendar.weeks.flatMap((week) => week.contributionDays);
  const { current, longest } = calculateStreaks(days);
  const commits = collection.totalCommitContributions;
  const formattedCommits = new Intl.NumberFormat("en-US").format(commits);

  let svg = await fs.readFile(SVG_PATH, "utf8");
  svg = replaceStatValue(svg, "stats-commits", formattedCommits);
  svg = replaceStatValue(svg, "stats-streak", String(current));
  svg = replaceStatValue(svg, "stats-longest-streak", String(longest));
  await fs.writeFile(SVG_PATH, svg, "utf8");

  console.log(
    `Updated stats for ${username}: commits=${formattedCommits}, streak=${current}, longest=${longest}`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
