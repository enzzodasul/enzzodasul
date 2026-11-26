import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateIssues,
  extractLinkedIssueRefs,
  fetchAllPages,
  matchCommitToIssue,
  renderStatsSvg,
  resolveUsername,
} from './update-stats.mjs';

test('resolveUsername prefers environment variable over git remote', () => {
  assert.equal(resolveUsername({ GITHUB_REPOSITORY_OWNER: 'enzzodasul' }), 'enzzodasul');
  assert.equal(resolveUsername({ GITHUB_STATS_USER: 'custom-user' }), 'custom-user');
});

test('matchCommitToIssue prevents collision between GitHub #63 and internal Issue #63', () => {
  const gh63 = { number: 63, title: 'Issue #13 – Criar página de Cadastro (multistep)', milestone: { title: '01 — EP1' } };
  const gh114 = { number: 114, title: 'Issue #63 – Criar ProcedureStep', milestone: { title: '04 — EP4' } };

  const commitMsg = 'feat(procedure-step): conclui Issue #63';
  assert.deepEqual(matchCommitToIssue(commitMsg, gh63), []);
  assert.deepEqual(matchCommitToIssue(commitMsg, gh114), ['commit:internal#63']);
});

test('matchCommitToIssue matches parenthesized GH ref (#180) and title match', () => {
  const gh180 = { number: 180, title: 'Issue #122 – Reconfigurar ESLint/Prettier e adicionar testes', milestone: { title: '08 — EP8' } };
  const gh179 = { number: 179, title: 'Issue #121 – Fixar versões das dependências', milestone: { title: '08 — EP8' } };

  assert.ok(matchCommitToIssue('chore: configura ESLint, Prettier e Vitest (#180)', gh180).includes('commit:gh#180'));
  assert.deepEqual(matchCommitToIssue('chore: fixa versões das dependências', gh179), ['commit:title-match']);
});

test('deduplicateIssues excludes PRs, avoids duplicates, counts milestones, and separates open/closed', () => {
  const input = [
    {
      id: 101,
      number: 184,
      title: 'Issue #126',
      state: 'closed',
      milestone: { title: '08 — EP8: Correções e Ajustes' },
      repository_url: 'https://api.github.com/repos/Soberana-Front/chatbot-soberana-web',
      user: { login: 'gabrieljorda' },
      _criterion: 'involves',
    },
    {
      id: 101,
      number: 184,
      title: 'Issue #126',
      state: 'closed',
      milestone: { title: '08 — EP8: Correções e Ajustes' },
      repository_url: 'https://api.github.com/repos/Soberana-Front/chatbot-soberana-web',
      user: { login: 'gabrieljorda' },
      _criterion: 'commenter',
    },
    {
      id: 102,
      number: 186,
      title: 'Issue #128',
      state: 'open',
      milestone: { title: '08 — EP8: Correções e Ajustes' },
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
  assert.equal(result.milestonesCount, 1);
  assert.deepEqual(result.repositories, ['Soberana-Front/chatbot-soberana-web']);
  assert.deepEqual(result.issues[0].criteria, ['involves', 'commenter']);
});

test('extractLinkedIssueRefs parses closing keywords and issue URLs', () => {
  const body = `
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

test('renderStatsSvg outputs valid SVG with Issues Participated and Milestones Participated', () => {
  const svg = renderStatsSvg(
    {
      displayName: 'Enzzo da Sul',
      totalStars: 0,
      totalCommits: 317,
      totalPRs: 2,
      totalIssues: 50,
      openIssues: 10,
      closedIssues: 40,
      milestonesParticipated: 5,
      contributedTo: 2,
    },
    'dark'
  );
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('50 (40 done · 10 open)'));
  assert.ok(svg.includes('Milestones Participated:'));
  assert.ok(svg.includes('#0D1117'));
});
