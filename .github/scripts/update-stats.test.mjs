import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateIssues,
  extractLinkedIssueRefs,
  fetchAllPages,
  renderStatsSvg,
  resolveUsername,
} from './update-stats.mjs';

test('resolveUsername prefers environment variable over git remote', () => {
  assert.equal(resolveUsername({ GITHUB_REPOSITORY_OWNER: 'enzzodasul' }), 'enzzodasul');
  assert.equal(resolveUsername({ GITHUB_STATS_USER: 'custom-user' }), 'custom-user');
});

test('deduplicateIssues excludes PRs, avoids duplicates, and separates open/closed', () => {
  const input = [
    {
      id: 101,
      number: 184,
      title: 'Issue 126',
      state: 'closed',
      repository_url: 'https://api.github.com/repos/Soberana-Front/chatbot-soberana-web',
      user: { login: 'gabrieljorda' },
      _criterion: 'involves',
    },
    {
      id: 101,
      number: 184,
      title: 'Issue 126',
      state: 'closed',
      repository_url: 'https://api.github.com/repos/Soberana-Front/chatbot-soberana-web',
      user: { login: 'gabrieljorda' },
      _criterion: 'org:Soberana-Front',
    },
    {
      id: 102,
      number: 186,
      title: 'Issue 128',
      state: 'open',
      repository_url: 'https://api.github.com/repos/Soberana-Front/chatbot-soberana-web',
      user: { login: 'gabrieljorda' },
      _criterion: 'involves',
    },
    {
      id: 200,
      number: 1,
      title: 'Some PR',
      state: 'open',
      pull_request: { url: 'https://api.github.com/repos/Soberana-Front/chatbot-soberana-web/pulls/1' },
      repository_url: 'https://api.github.com/repos/Soberana-Front/chatbot-soberana-web',
      user: { login: 'enzzodasul' },
      _criterion: 'involves',
    },
  ];

  const result = deduplicateIssues(input);
  assert.equal(result.total, 2);
  assert.equal(result.openCount, 1);
  assert.equal(result.closedCount, 1);
  assert.deepEqual(result.repositories, ['Soberana-Front/chatbot-soberana-web']);
  assert.deepEqual(result.issues[0].criteria, ['involves', 'org:Soberana-Front']);
});

test('extractLinkedIssueRefs parses closing keywords and issue URLs', () => {
  const body = `
    Implemented feature.
    Closes #42
    Fixes Soberana-Front/chatbot-soberana-web#184
    See https://github.com/Soberana-Front/chatbot-soberana-web/issues/169
  `;
  const refs = extractLinkedIssueRefs(body, 'enzzodasul/app');
  assert.deepEqual(refs, [
    'enzzodasul/app#42',
    'Soberana-Front/chatbot-soberana-web#184',
    'Soberana-Front/chatbot-soberana-web#169',
  ]);
});

test('fetchAllPages paginates until a partial page is returned', async () => {
  let calls = 0;
  const mockFetch = async (url) => {
    calls += 1;
    const isPage1 = new URL(url).searchParams.get('page') === '1';
    const items = isPage1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }];
    return {
      ok: true,
      json: async () => ({ total_count: 101, items }),
    };
  };

  const results = await fetchAllPages(
    (page, perPage) => `https://api.github.com/search/issues?page=${page}&per_page=${perPage}`,
    mockFetch,
    {}
  );
  assert.equal(calls, 2);
  assert.equal(results.length, 101);
});

test('renderStatsSvg outputs valid SVG containing dynamic Total Issues count', () => {
  const svg = renderStatsSvg(
    {
      displayName: 'Enzzo da Sul',
      totalStars: 0,
      totalCommits: 314,
      totalPRs: 2,
      totalIssues: 12,
      openIssues: 9,
      closedIssues: 3,
      contributedTo: 2,
    },
    'dark'
  );
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('12 (9 open · 3 closed)'));
  assert.ok(svg.includes("Enzzo da Sul&apos;s GitHub Stats"));
  assert.ok(svg.includes('#0D1117'));
});
