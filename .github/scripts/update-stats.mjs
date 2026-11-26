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
    // Ignore git remote error
  }
  throw new Error('Could not determine GitHub username from environment or git remote.');
}

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
 * Fetch all pages from a paginated GitHub REST endpoint (per_page=100).
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
    if (!Array.isArray(data) && results.length >= Math.min(data.total_count ?? Infinity, 1000)) {
      break;
    }
    page += 1;
  }

  return results;
}

/**
 * Normalize text for token comparison (lowercase, strip accents & punctuation).
 */
export function normalizeText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse verifiable issue references from a Pull Request title/body.
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
 * Extract internal issue number or code from an issue title (e.g., "Issue #112" -> "112", "FE-013" -> "FE-013").
 */
export function parseIssueTitleMeta(title) {
  const internalMatch = String(title || '').match(/Issue\s*#(\d+)/i);
  const feMatch = String(title || '').match(/\b(FE-\d+)\b/i);
  return {
    internalNumber: internalMatch ? Number(internalMatch[1]) : null,
    feCode: feMatch ? feMatch[1].toUpperCase() : null,
  };
}

/**
 * Match a user-authored commit against an issue with strict collision-safe rules:
 * 1. Explicit GitHub PR/commit suffix `(#167)` matches GitHub issue #167 (never internal #N).
 * 2. Explicit `Issue #N` or `issue N` in commit matches the issue's internal title `Issue #N`.
 * 3. Explicit range statement like `EP2: Dashboard (#28 a #44 / #85 a #95)` matches EP2 milestone issues.
 * 4. High-confidence title token match (e.g., `fixa versoes das dependencias` -> `Fixar versoes das dependencias`).
 */
export function matchCommitToIssue(commitMsg, issue) {
  const msg = String(commitMsg || '');
  const { internalNumber, feCode } = parseIssueTitleMeta(issue.title);
  const evidence = [];

  // 1. Parenthesized GitHub issue ref like `(#167)` or `(#180)`
  const ghParenRegex = new RegExp(`\\(#${issue.number}\\)`);
  if (ghParenRegex.test(msg)) {
    evidence.push(`commit:gh#${issue.number}`);
  }

  // 2. Explicit `Issue #N` / `issue N` -> matches internalNumber in title (prevents #63 vs Issue #63 collision)
  if (internalNumber !== null) {
    const intRegex = new RegExp(`\\b(?:issue|isshue)\\s*#?${internalNumber}\\b`, 'i');
    if (intRegex.test(msg)) {
      evidence.push(`commit:internal#${internalNumber}`);
    }
    // Also match `Issues #74 #75`
    const multiIntRegex = new RegExp(`\\bissues\\b[^\\n]*#${internalNumber}\\b`, 'i');
    if (multiIntRegex.test(msg)) {
      evidence.push(`commit:internal#${internalNumber}`);
    }
  }

  // 3. Explicit FE-NNN code
  if (feCode && msg.toUpperCase().includes(feCode)) {
    evidence.push(`commit:${feCode}`);
  }

  // 4. Explicit milestone summary range e.g. "EP2: Dashboard (#28 a #44 / #85 a #95)"
  if (issue.milestone?.title?.includes('EP2') && /conclui\s+100%\s+das\s+issues\s+do\s+EP2/i.test(msg)) {
    evidence.push('commit:EP2-summary');
  }

  // 5. High-confidence title/component match (for commits without #number, like "fixa versoes das dependencias" or "ClinicStep")
  const normTitle = normalizeText(issue.title.replace(/Issue\s*#\d+\s*[–-]?/i, ''));
  const normSubject = normalizeText(msg.split('\n')[0]);
  const stopWords = new Set(['criar', 'corrigir', 'adicionar', 'atualizar', 'integrar', 'para', 'com', 'das', 'dos', 'que', 'nao', 'uma', 'por', 'componente', 'pagina', 'etapa', 'hook']);
  const titleTokens = normTitle.split(' ').filter((t) => t.length >= 4 && !stopWords.has(t));

  if (titleTokens.length >= 2) {
    const matchedTokens = titleTokens.filter((t) => normSubject.includes(t.slice(0, Math.min(t.length, 4))));
    if (matchedTokens.length >= 2 && matchedTokens.length / titleTokens.length >= 0.65) {
      evidence.push('commit:title-match');
    }
  }

  return [...new Set(evidence)];
}

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
 * Deduplicate issues by unique key and aggregate participation evidence + milestones.
 */
export function deduplicateIssues(records) {
  const map = new Map();

  for (const item of records) {
    if (item.pull_request) continue;

    const repo = item._repo || getRepoFullName(item);
    const key = item.id ? `id:${item.id}` : `${repo}#${item.number}`;
    const existing = map.get(key);
    const criteria = new Set(existing?.criteria ?? []);
    for (const c of item._criteria ?? (item._criterion ? [item._criterion] : [])) {
      criteria.add(c);
    }

    map.set(key, {
      id: item.id ?? key,
      number: item.number,
      repo,
      title: item.title,
      state: item.state === 'closed' ? 'closed' : 'open',
      milestone: item.milestone ? item.milestone.title : null,
      author: item.user?.login ?? 'unknown',
      html_url: item.html_url,
      criteria: [...criteria],
    });
  }

  const all = [...map.values()].sort((a, b) => a.number - b.number);
  const open = all.filter((i) => i.state === 'open');
  const closed = all.filter((i) => i.state === 'closed');
  const repositories = [...new Set(all.map((i) => i.repo))].sort();
  const milestones = [...new Set(all.map((i) => i.milestone).filter(Boolean))].sort();

  return {
    total: all.length,
    openCount: open.length,
    closedCount: closed.length,
    milestonesCount: milestones.length,
    milestones,
    repositories,
    issues: all,
    open,
    closed,
  };
}

/**
 * Check if a commit was authored by the target user.
 */
function isCommitByUser(commit, username) {
  const u = username.toLowerCase();
  const shortName = u.replace('dasul', '');
  return (
    commit.author?.login?.toLowerCase() === u ||
    commit.committer?.login?.toLowerCase() === u ||
    (commit.commit?.author?.name || '').toLowerCase().includes(shortName) ||
    (commit.commit?.author?.email || '').toLowerCase().includes(u)
  );
}

/**
 * Audit a repository deeply: all issues (state=all), all comments, all branches' commits, and all milestones.
 */
async function auditRepositoryDeep(repo, username, fetchImpl, headers) {
  const [allItems, allComments, branches, milestones] = await Promise.all([
    fetchAllPages((p, pp) => `https://api.github.com/repos/${repo}/issues?state=all&per_page=${pp}&page=${p}`, fetchImpl, headers),
    fetchAllPages((p, pp) => `https://api.github.com/repos/${repo}/issues/comments?per_page=${pp}&page=${p}`, fetchImpl, headers),
    fetchAllPages((p, pp) => `https://api.github.com/repos/${repo}/branches?per_page=${pp}&page=${p}`, fetchImpl, headers),
    fetchAllPages((p, pp) => `https://api.github.com/repos/${repo}/milestones?state=all&per_page=${pp}&page=${p}`, fetchImpl, headers),
  ]);

  const issues = allItems.filter((i) => !i.pull_request);
  const commentsByIssue = new Map();
  for (const c of allComments) {
    if (!commentsByIssue.has(c.issue_url)) commentsByIssue.set(c.issue_url, []);
    commentsByIssue.get(c.issue_url).push(c);
  }

  // Deduplicate commits across all branches
  const commitMap = new Map();
  for (const b of branches) {
    const bCommits = await fetchAllPages(
      (p, pp) => `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(b.name)}&per_page=${pp}&page=${p}`,
      fetchImpl,
      headers
    );
    for (const c of bCommits) {
      if (!commitMap.has(c.sha)) commitMap.set(c.sha, c);
    }
  }
  const userCommits = [...commitMap.values()].filter((c) => isCommitByUser(c, username));

  const matched = [];
  for (const issue of issues) {
    const criteria = [];
    if (issue.user?.login?.toLowerCase() === username.toLowerCase()) criteria.push('author');
    if (issue.assignees?.some((a) => a.login?.toLowerCase() === username.toLowerCase())) criteria.push('assignee');

    const iComments = commentsByIssue.get(issue.url) || [];
    if (iComments.some((c) => c.user?.login?.toLowerCase() === username.toLowerCase())) criteria.push('commenter');

    const textBlob = `${issue.body || ''}\n${iComments.map((c) => c.body || '').join('\n')}`;
    if (new RegExp(`@?${username}\\b`, 'i').test(textBlob)) criteria.push('mentioned');

    for (const c of userCommits) {
      const commitMatches = matchCommitToIssue(c.commit?.message || '', issue);
      for (const m of commitMatches) {
        criteria.push(`${m}(${c.sha.slice(0, 7)})`);
      }
    }

    if (criteria.length > 0) {
      matched.push({ ...issue, _repo: repo, _criteria: [...new Set(criteria)] });
    }
  }

  return {
    repo,
    totalIssuesInRepo: issues.length,
    milestones: milestones.map((m) => ({
      number: m.number,
      title: m.title,
      state: m.state,
      open_issues: m.open_issues,
      closed_issues: m.closed_issues,
    })),
    matchedIssues: matched,
  };
}

/**
 * Collect all issues across GitHub, including deep repo/milestone/commit audit for Soberana-Front and discovered repos.
 */
export async function collectUserIssues(username, fetchImpl = fetch, headers = buildHeaders()) {
  const collected = [];
  const auditedRepos = new Map();

  // 1. Global search: involves:username is:issue
  const involvesItems = await fetchAllPages(
    (page, perPage) =>
      `https://api.github.com/search/issues?q=${encodeURIComponent(`involves:${username} is:issue`)}&per_page=${perPage}&page=${page}`,
    fetchImpl,
    headers
  );
  for (const item of involvesItems) {
    collected.push({ ...item, _criterion: 'involves' });
  }

  // 2. Discover Soberana-Front org repos & PRs authored by user
  const [soberanaRepos, userPRs] = await Promise.all([
    fetchAllPages((p, pp) => `https://api.github.com/orgs/Soberana-Front/repos?type=all&per_page=${pp}&page=${p}`, fetchImpl, headers).catch(() => []),
    fetchAllPages(
      (page, perPage) =>
        `https://api.github.com/search/issues?q=${encodeURIComponent(`author:${username} is:pr`)}&per_page=${perPage}&page=${page}`,
      fetchImpl,
      headers
    ),
  ]);

  // Deduplicate repo names (handles Soberana-Front/front -> Soberana-Front/chatbot-soberana-web migration via repo id)
  const reposToAudit = new Map();
  for (const r of soberanaRepos) {
    reposToAudit.set(r.id, r.full_name);
  }
  for (const item of involvesItems) {
    const repoName = getRepoFullName(item);
    if (![...reposToAudit.values()].includes(repoName)) {
      reposToAudit.set(repoName, repoName);
    }
  }

  // Deep audit each discovered repository (issues, milestones, comments, commits across all branches)
  for (const repoFullName of reposToAudit.values()) {
    const repoAudit = await auditRepositoryDeep(repoFullName, username, fetchImpl, headers);
    auditedRepos.set(repoFullName, repoAudit);
    collected.push(...repoAudit.matchedIssues);
  }

  // 3. Linked issues from PRs authored by user
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
            collected.push({ ...issueData, _repo: repo, _criterion: 'pr-linked' });
          }
        }
      } catch {
        // Ignore inaccessible issue references
      }
    }
  }

  return {
    issueStats: deduplicateIssues(collected),
    prCount: userPRs.length,
    prRepos: userPRs.map((pr) => getRepoFullName(pr)),
    auditedRepos: [...auditedRepos.values()],
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

  const repos = await fetchAllPages(
    (page, perPage) => `https://api.github.com/users/${username}/repos?per_page=${perPage}&page=${page}`,
    fetchImpl,
    headers
  );
  const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);

  const { issueStats, prCount, prRepos, auditedRepos } = await collectUserIssues(username, fetchImpl, headers);

  let totalCommits = null;
  let contributedTo = null;

  if (headers.Authorization) {
    const gqlQuery = `
      query($login: String!) {
        user(login: $login) {
          contributionsCollection {
            totalCommitContributions
            restrictedContributionsCount
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

  if (totalCommits === null) {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const since = oneYearAgo.toISOString().slice(0, 10);
    const commitRes = await fetchImpl(
      `https://api.github.com/search/commits?q=${encodeURIComponent(`author:${username} author-date:>=${since}`)}&per_page=1`,
      { headers: { ...headers, Accept: 'application/vnd.github.cloak-preview+json' } }
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

  return {
    username,
    displayName: (user.name || username).trim(),
    totalStars,
    totalCommits,
    totalPRs: prCount,
    totalIssues: issueStats.total,
    openIssues: issueStats.openCount,
    closedIssues: issueStats.closedCount,
    milestonesParticipated: issueStats.milestonesCount,
    milestones: issueStats.milestones,
    contributedTo,
    repositories: issueStats.repositories,
    auditedRepos,
    issues: issueStats.issues,
  };
}

export function computeRank({ totalCommits, totalPRs, totalIssues, totalStars }) {
  const score = totalCommits * 1 + totalPRs * 2 + totalIssues * 1.5 + totalStars * 4;
  if (score >= 1500) return { level: 'S', progress: 0.92 };
  if (score >= 800) return { level: 'A+', progress: 0.8 };
  if (score >= 400) return { level: 'A', progress: 0.68 };
  if (score >= 150) return { level: 'B+', progress: 0.56 };
  if (score >= 50) return { level: 'B', progress: 0.42 };
  return { level: 'C', progress: 0.25 };
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render the GitHub Stats SVG card preserving the dark/light visual identity.
 */
export function renderStatsSvg(metrics, theme = 'dark') {
  const isDark = theme === 'dark';
  const palette = isDark
    ? {
        bg: '#0D1117',
        title: '#A78BFA',
        text: '#E6EDF3',
        icon: '#06B6D4',
        ring: '#7C3AED',
        ringTrack: '#21262D',
      }
    : {
        bg: '#FFFFFF',
        title: '#7C3AED',
        text: '#1F2328',
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
      label: 'Issues Participated:',
      value: `${metrics.totalIssues} (${metrics.closedIssues} done · ${metrics.openIssues} open)`,
      icon: '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>',
    },
    {
      label: 'Milestones Participated:',
      value: String(metrics.milestonesParticipated),
      icon: '<path d="M7.75 0a.75.75 0 0 1 .75.75V3h3.634c.414 0 .814.147 1.13.414l2.07 1.75a1.75 1.75 0 0 1 0 2.672l-2.07 1.75a1.75 1.75 0 0 1-1.13.414H8.5v5.25a.75.75 0 0 1-1.5 0V10H2.75A1.75 1.75 0 0 1 1 8.25v-3.5C1 3.784 1.784 3 2.75 3H7V.75A.75.75 0 0 1 7.75 0Zm4.384 8.5a.25.25 0 0 0 .161-.06l2.07-1.75a.25.25 0 0 0 0-.38l-2.07-1.75a.25.25 0 0 0-.161-.06H2.75a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h9.384Z"/>',
    },
    {
      label: 'Contributed to (last year):',
      value: String(metrics.contributedTo),
      icon: '<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>',
    },
  ];

  const rowsMarkup = rows
    .map((row, idx) => {
      const y = idx * 24;
      return `
      <g transform="translate(0, ${y})">
        <svg x="25" y="0" width="16" height="16" viewBox="0 0 16 16" fill="${palette.icon}">${row.icon}</svg>
        <text x="50" y="12.5" fill="${palette.text}" font-family="'Segoe UI', Ubuntu, Sans-Serif" font-weight="600" font-size="13">${escapeXml(row.label)}</text>
        <text x="225" y="12.5" fill="${palette.text}" font-family="'Segoe UI', Ubuntu, Sans-Serif" font-weight="700" font-size="13">${escapeXml(row.value)}</text>
      </g>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="215" viewBox="0 0 520 215" fill="none" role="img" aria-label="${escapeXml(titleText)}">
  <rect x="0" y="0" width="520" height="215" rx="4.5" fill="${palette.bg}"/>
  <g transform="translate(25, 34)">
    <text x="0" y="0" fill="${palette.title}" font-family="'Segoe UI', Ubuntu, Sans-Serif" font-weight="600" font-size="18">${escapeXml(titleText)}</text>
  </g>
  <g transform="translate(0, 54)">
    ${rowsMarkup}
  </g>
  <g transform="translate(450, 118)">
    <circle cx="0" cy="0" r="${radius}" fill="none" stroke="${palette.ringTrack}" stroke-width="6"/>
    <circle cx="0" cy="0" r="${radius}" fill="none" stroke="${palette.ring}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset}" transform="rotate(-90)"/>
    <text x="0" y="8" text-anchor="middle" fill="${palette.text}" font-family="'Segoe UI', Ubuntu, Sans-Serif" font-weight="800" font-size="24">${escapeXml(rank.level)}</text>
  </g>
</svg>
`;
}

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
        milestonesParticipated: metrics.milestonesParticipated,
        milestones: metrics.milestones,
        contributedTo: metrics.contributedTo,
        repositories: metrics.repositories,
        auditedRepos: metrics.auditedRepos.map((r) => ({
          repo: r.repo,
          totalIssuesInRepo: r.totalIssuesInRepo,
          milestones: r.milestones,
        })),
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
  console.log(`  Issues Participated: ${metrics.totalIssues} (${metrics.closedIssues} done, ${metrics.openIssues} open)`);
  console.log(`  Milestones Participated: ${metrics.milestonesParticipated}`);
  console.log(`  Contributed to: ${metrics.contributedTo}`);
}

if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
