import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * Resolve the GitHub username from environment or git remote configuration.
 */
export function resolveUsername(env = process.env, rootDir = ROOT_DIR) {
  if (env.GITHUB_STATS_USER?.trim()) {
    return env.GITHUB_STATS_USER.trim();
  }
  if (env.GITHUB_REPOSITORY_OWNER?.trim()) {
    return env.GITHUB_REPOSITORY_OWNER.trim();
  }
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = remoteUrl.match(/github\.com[:/]([^/]+)\//i);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Fallback to checking README or git config
  }
  throw new Error('Could not determine GitHub username from environment or git remote.');
}

/**
 * Create GitHub API request headers.
 */
function buildHeaders(token = process.env.GITHUB_TOKEN) {
  const headers = {
    'User-Agent': 'enzzodasul-github-stats-generator',
    Accept: 'application/vnd.github+json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fetch all pages from a paginated GitHub REST endpoint.
 */
export async function fetchAllPages(buildUrl, fetchImpl = fetch, headers = buildHeaders()) {
  const results = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = buildUrl(page, perPage);
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API error ${res.status} for ${url}: ${body}`);
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : data.items ?? [];
    results.push(...items);

    if (items.length < perPage) break;
    // GitHub Search API caps results at 1000 items (10 pages of 100)
    if (!Array.isArray(data) && results.length >= Math.min(data.total_count ?? Infinity, 1000)) {
      break;
    }
    page += 1;
  }

  return results;
}

/**
 * Parse verifiable issue references from a Pull Request title/body.
 * Supports: "Closes #123", "Fixes owner/repo#45", "Resolves https://github.com/owner/repo/issues/99"
 */
export function extractLinkedIssueRefs(text, defaultRepo) {
  if (!text) return [];
  const refs = new Set();

  const keywordPattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref(?:erences?)?)\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/gi;
  for (const match of text.matchAll(keywordPattern)) {
    const repo = match[1] || defaultRepo;
    const number = Number(match[2]);
    if (repo && number > 0) refs.add(`${repo}#${number}`);
  }

  const urlPattern = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/gi;
  for (const match of text.matchAll(urlPattern)) {
    refs.add(`${match[1]}#${Number(match[2])}`);
  }

  return [...refs];
}

/**
 * Normalize repository full name from an issue object.
 */
export function getRepoFullName(issue) {
  if (issue.repository_url) {
    return issue.repository_url.replace('https://api.github.com/repos/', '');
  }
  if (issue.html_url) {
    const m = issue.html_url.match(/github\.com\/([^/]+\/[^/]+)\//);
    if (m) return m[1];
  }
  return 'unknown/unknown';
}

/**
 * Deduplicate issues by unique key (repo#number / id) and merge participation criteria.
 */
export function deduplicateIssues(records) {
  const map = new Map();

  for (const item of records) {
    // Strictly exclude Pull Requests
    if (item.pull_request) continue;

    const repo = getRepoFullName(item);
    const key = item.id ? `id:${item.id}` : `${repo}#${item.number}`;
    const existing = map.get(key);
    const criteria = new Set(existing?.criteria ?? []);
    if (item._criterion) criteria.add(item._criterion);

    map.set(key, {
      id: item.id ?? key,
      number: item.number,
      repo,
      title: item.title,
      state: item.state === 'closed' ? 'closed' : 'open',
      author: item.user?.login ?? 'unknown',
      html_url: item.html_url,
      criteria: [...criteria],
    });
  }

  const all = [...map.values()];
  const open = all.filter((i) => i.state === 'open');
  const closed = all.filter((i) => i.state === 'closed');
  const repositories = [...new Set(all.map((i) => i.repo))].sort();

  return {
    total: all.length,
    openCount: open.length,
    closedCount: closed.length,
    repositories,
    issues: all,
    open,
    closed,
  };
}

/**
 * Collect all issues the user participated in across GitHub (including Soberana-Front).
 */
export async function collectUserIssues(username, fetchImpl = fetch, headers = buildHeaders()) {
  const collected = [];

  // 1. All issues involving the user (created, assigned, commented, mentioned)
  const involvesItems = await fetchAllPages(
    (page, perPage) =>
      `https://api.github.com/search/issues?q=${encodeURIComponent(`involves:${username} is:issue`)}&per_page=${perPage}&page=${page}`,
    fetchImpl,
    headers
  );
  for (const item of involvesItems) {
    const criteria = [];
    if (item.user?.login?.toLowerCase() === username.toLowerCase()) criteria.push('author');
    if (item.assignees?.some((a) => a.login?.toLowerCase() === username.toLowerCase())) criteria.push('assignee');
    collected.push({ ...item, _criterion: criteria[0] || 'involves' });
    for (const c of criteria.slice(1)) {
      collected.push({ ...item, _criterion: c });
    }
  }

  // 2. Explicit Soberana-Front org query (ensures org repos are explicitly covered)
  const soberanaItems = await fetchAllPages(
    (page, perPage) =>
      `https://api.github.com/search/issues?q=${encodeURIComponent(`org:Soberana-Front involves:${username} is:issue`)}&per_page=${perPage}&page=${page}`,
    fetchImpl,
    headers
  );
  for (const item of soberanaItems) {
    collected.push({ ...item, _criterion: 'org:Soberana-Front' });
  }

  // 3. Issues verifiably linked to Pull Requests authored by the user
  const userPRs = await fetchAllPages(
    (page, perPage) =>
      `https://api.github.com/search/issues?q=${encodeURIComponent(`author:${username} is:pr`)}&per_page=${perPage}&page=${page}`,
    fetchImpl,
    headers
  );

  for (const pr of userPRs) {
    const prRepo = getRepoFullName(pr);
    const refs = extractLinkedIssueRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`, prRepo);
    for (const ref of refs) {
      const [repo, num] = ref.split('#');
      try {
        const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${num}`, { headers });
        if (res.ok) {
          const issueData = await res.json();
          if (!issueData.pull_request) {
            collected.push({ ...issueData, _criterion: 'pr-linked' });
          }
        }
      } catch {
        // Ignore inaccessible or deleted issue references
      }
    }
  }

  return {
    issueStats: deduplicateIssues(collected),
    prCount: userPRs.length,
    prRepos: userPRs.map((pr) => getRepoFullName(pr)),
  };
}

/**
 * Fetch commits, stars, contributed repos, and user display name.
 */
export async function collectProfileMetrics(username, fetchImpl = fetch, headers = buildHeaders()) {
  const userRes = await fetchImpl(`https://api.github.com/users/${username}`, { headers });
  if (!userRes.ok) {
    throw new Error(`Failed to fetch user ${username}: ${userRes.status}`);
  }
  const user = await userRes.json();

  // Total stars across all public repos (paginated)
  const repos = await fetchAllPages(
    (page, perPage) =>
      `https://api.github.com/users/${username}/repos?per_page=${perPage}&page=${page}`,
    fetchImpl,
    headers
  );
  const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);

  // Issues & PRs
  const { issueStats, prCount, prRepos } = await collectUserIssues(username, fetchImpl, headers);

  // Commits & Contributed to (last year)
  let totalCommits = null;
  let contributedTo = null;

  if (headers.Authorization) {
    // Use GraphQL when GITHUB_TOKEN is available for exact last-year commit & repo counts
    const gqlQuery = `
      query($login: String!) {
        user(login: $login) {
          contributionsCollection {
            totalCommitContributions
            restrictedContributionsCount
            totalRepositoriesWithContributedCommits
          }
          repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
            totalCount
          }
        }
      }
    `;
    const gqlRes = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gqlQuery, variables: { login: username } }),
    });
    if (gqlRes.ok) {
      const gqlJson = await gqlRes.json();
      const cc = gqlJson?.data?.user?.contributionsCollection;
      if (cc) {
        totalCommits = (cc.totalCommitContributions ?? 0) + (cc.restrictedContributionsCount ?? 0);
      }
      const repoContrib = gqlJson?.data?.user?.repositoriesContributedTo?.totalCount;
      if (typeof repoContrib === 'number') {
        contributedTo = repoContrib;
      }
    }
  }

  // Unauthenticated REST fallback for commits (last year)
  if (totalCommits === null) {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const since = oneYearAgo.toISOString().slice(0, 10);
    const commitRes = await fetchImpl(
      `https://api.github.com/search/commits?q=${encodeURIComponent(`author:${username} author-date:>=${since}`)}&per_page=1`,
      {
        headers: {
          ...headers,
          Accept: 'application/vnd.github.cloak-preview+json',
        },
      }
    );
    if (commitRes.ok) {
      const commitData = await commitRes.json();
      totalCommits = commitData.total_count ?? 0;
    } else {
      totalCommits = 0;
    }
  }

  if (contributedTo === null) {
    const externalRepos = new Set([
      ...prRepos.filter((r) => !r.toLowerCase().startsWith(`${username.toLowerCase()}/`)),
      ...issueStats.repositories.filter((r) => !r.toLowerCase().startsWith(`${username.toLowerCase()}/`)),
    ]);
    contributedTo = externalRepos.size;
  }

  const displayName = (user.name || username).trim();

  return {
    username,
    displayName,
    totalStars,
    totalCommits,
    totalPRs: prCount,
    totalIssues: issueStats.total,
    openIssues: issueStats.openCount,
    closedIssues: issueStats.closedCount,
    contributedTo,
    repositories: issueStats.repositories,
    issues: issueStats.issues,
  };
}

/**
 * Compute rank label and ring progress (0-1) using github-readme-stats style weighting.
 */
export function computeRank({ totalCommits, totalPRs, totalIssues, totalStars }) {
  const score = totalCommits * 1 + totalPRs * 2 + totalIssues * 1.5 + totalStars * 4;
  if (score >= 1500) return { level: 'S', progress: 0.92 };
  if (score >= 800) return { level: 'A+', progress: 0.8 };
  if (score >= 400) return { level: 'A', progress: 0.68 };
  if (score >= 150) return { level: 'B+', progress: 0.56 };
  if (score >= 50) return { level: 'B', progress: 0.42 };
  return { level: 'C', progress: 0.25 };
}

/**
 * Escape XML special characters for safe SVG text interpolation.
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render the GitHub Stats SVG card preserving the exact dark/light layout.
 */
export function renderStatsSvg(metrics, theme = 'dark') {
  const isDark = theme === 'dark';
  const palette = isDark
    ? {
        bg: '#0D1117',
        title: '#A78BFA',
        text: '#E6EDF3',
        muted: '#7D8590',
        icon: '#06B6D4',
        ring: '#7C3AED',
        ringTrack: '#21262D',
      }
    : {
        bg: '#FFFFFF',
        title: '#7C3AED',
        text: '#1F2328',
        muted: '#656D76',
        icon: '#06B6D4',
        ring: '#7C3AED',
        ringTrack: '#E5E7EB',
      };

  const rank = computeRank(metrics);
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = (circumference * (1 - rank.progress)).toFixed(2);
  const titleText = `${metrics.displayName}'s GitHub Stats`;

  const rows = [
    {
      label: 'Total Stars Earned:',
      value: String(metrics.totalStars),
      icon: '<path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>',
    },
    {
      label: 'Total Commits (last year):',
      value: String(metrics.totalCommits),
      icon: '<path d="M10.5 7.75a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm1.43.75a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 1 1 0-1.5h3.32a4.001 4.001 0 0 1 7.86 0h3.32a.75.75 0 1 1 0 1.5h-3.32Z"/>',
    },
    {
      label: 'Total PRs:',
      value: String(metrics.totalPRs),
      icon: '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>',
    },
    {
      label: 'Total Issues:',
      value: `${metrics.totalIssues} (${metrics.openIssues} open · ${metrics.closedIssues} closed)`,
      icon: '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>',
    },
    {
      label: 'Contributed to (last year):',
      value: String(metrics.contributedTo),
      icon: '<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>',
    },
  ];

  const rowsMarkup = rows
    .map((row, idx) => {
      const y = idx * 25;
      return `
      <g transform="translate(0, ${y})">
        <svg x="25" y="0" width="16" height="16" viewBox="0 0 16 16" fill="${palette.icon}">${row.icon}</svg>
        <text x="50" y="12.5" fill="${palette.text}" font-family="'Segoe UI', Ubuntu, Sans-Serif" font-weight="600" font-size="13.5">${escapeXml(row.label)}</text>
        <text x="235" y="12.5" fill="${palette.text}" font-family="'Segoe UI', Ubuntu, Sans-Serif" font-weight="700" font-size="13.5">${escapeXml(row.value)}</text>
      </g>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195" fill="none" role="img" aria-label="${escapeXml(titleText)}">
  <rect x="0" y="0" width="495" height="195" rx="4.5" fill="${palette.bg}"/>
  <g transform="translate(25, 35)">
    <text x="0" y="0" fill="${palette.title}" font-family="'Segoe UI', Ubuntu, Sans-Serif" font-weight="600" font-size="18">${escapeXml(titleText)}</text>
  </g>
  <g transform="translate(0, 56)">
    ${rowsMarkup}
  </g>
  <g transform="translate(425, 108)">
    <circle cx="0" cy="0" r="${radius}" fill="none" stroke="${palette.ringTrack}" stroke-width="6"/>
    <circle cx="0" cy="0" r="${radius}" fill="none" stroke="${palette.ring}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset}" transform="rotate(-90)"/>
    <text x="0" y="8" text-anchor="middle" fill="${palette.text}" font-family="'Segoe UI', Ubuntu, Sans-Serif" font-weight="800" font-size="24">${escapeXml(rank.level)}</text>
  </g>
</svg>
`;
}

/**
 * Main CLI execution entrypoint.
 */
export async function main() {
  const username = resolveUsername();
  const metrics = await collectProfileMetrics(username);

  const assetsDir = path.join(ROOT_DIR, '.github', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  fs.writeFileSync(path.join(assetsDir, 'stats-dark.svg'), renderStatsSvg(metrics, 'dark'), 'utf8');
  fs.writeFileSync(path.join(assetsDir, 'stats-light.svg'), renderStatsSvg(metrics, 'light'), 'utf8');
  fs.writeFileSync(
    path.join(assetsDir, 'stats-summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        username: metrics.username,
        totalStars: metrics.totalStars,
        totalCommits: metrics.totalCommits,
        totalPRs: metrics.totalPRs,
        totalIssues: metrics.totalIssues,
        openIssues: metrics.openIssues,
        closedIssues: metrics.closedIssues,
        contributedTo: metrics.contributedTo,
        repositories: metrics.repositories,
        issues: metrics.issues,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`Updated GitHub stats for ${username}:`);
  console.log(`  Total Stars: ${metrics.totalStars}`);
  console.log(`  Total Commits (last year): ${metrics.totalCommits}`);
  console.log(`  Total PRs: ${metrics.totalPRs}`);
  console.log(`  Total Issues: ${metrics.totalIssues} (${metrics.openIssues} open, ${metrics.closedIssues} closed)`);
  console.log(`  Contributed to: ${metrics.contributedTo}`);
  console.log(`  Repositories with issues: ${metrics.repositories.join(', ')}`);
}

if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
