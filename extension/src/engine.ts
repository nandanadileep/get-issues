/**
 * Matching engine v2.
 *
 * Profile signals: merged-PR languages, PR-title keywords, PR file paths
 * (domain dirs), topics of contributed repos, topics+languages of starred
 * repos (your interest graph). Queries are topic/keyword-driven, searched
 * via GitHub hybrid semantic issue search, then ranked with an added
 * maintainer-responsiveness signal per repo.
 */
import { graphql, searchIssues } from './api';

const PER_PAGE = 10;
const MAX_QUERIES = 5;
const MAX_RESP_REPOS = 12;

const CONV_PREFIX =
  /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style)(\(.+?\))?!?\s*:\s*/i;
const STOPWORDS = new Set(
  `the a an and or of to in for on with from by at is are was were be been this that
it its as into about over after before when while not no yes add adds added adding
update updates updated updating remove removes removed fix fixes fixed use uses used
using make makes made support handle improve implement change changes bump set new`
    .split(/\s+/)
);
const GENERIC_DIRS = new Set([
  'src', 'lib', 'app', 'test', 'tests', 'docs', 'doc', 'pkg', 'internal',
  'cmd', 'scripts', 'script', 'assets', 'public', 'vendor', 'node_modules',
]);
const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface Options {
  minStars: number;
  maxAgeDays: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Pr {
  title: string;
  files?: { nodes: { path: string }[] } | null;
  repository: {
    nameWithOwner: string;
    primaryLanguage?: { name: string } | null;
    repositoryTopics?: { nodes: { topic: { name: string } }[] } | null;
  };
  [k: string]: any;
}

export interface Profile {
  login: string;
  languages: [string, number][];
  keywords: [string, number][];
  topics: [string, number][];
  dirs: [string, number][];
  prs: Pr[];
}

export interface Query {
  text: string;
  lang: string | null;
  why: string;
}

export interface Match {
  score: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  ageDays: number;
  comments: number;
  stars: number;
  language: string;
  gfi: boolean;
  resp: string | null;
  labels: string[];
  reasons: string[];
  matched: string[];
}

export interface Feed {
  profile: Profile;
  queries: Query[];
  matches: Match[];
  builtAt: string;
}

const PROFILE_QUERY = `
{
  viewer {
    login
    pullRequests(first: 50, states: MERGED,
                 orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        title
        files(first: 15) { nodes { path } }
        repository {
          nameWithOwner
          primaryLanguage { name }
          repositoryTopics(first: 5) { nodes { topic { name } } }
        }
      }
    }
    repositories(first: 30, ownerAffiliations: OWNER, isFork: false,
                 orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { primaryLanguage { name } }
    }
    starredRepositories(first: 40,
                        orderBy: {field: STARRED_AT, direction: DESC}) {
      nodes {
        nameWithOwner
        primaryLanguage { name }
        repositoryTopics(first: 5) { nodes { topic { name } } }
      }
    }
  }
}
`;

function bump(map: Map<string, number>, key: string | undefined, w = 1): void {
  if (key) map.set(key, (map.get(key) ?? 0) + w);
}

const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function topicsOf(node: any): string[] {
  return (node?.repositoryTopics?.nodes ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (n: any) => n.topic?.name as string
  ).filter(Boolean);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildProfile(data: any): Profile {
  const viewer = data.data.viewer;
  const prs: Pr[] = (viewer.pullRequests.nodes || []).filter(
    (p: Pr | null) => p && p.repository
  );

  const langCount = new Map<string, number>();
  const topicCount = new Map<string, number>();
  const dirCount = new Map<string, number>();
  const kw = new Map<string, number>();

  for (const p of prs) {
    bump(langCount, p.repository.primaryLanguage?.name);
    for (const t of topicsOf(p.repository)) bump(topicCount, t, 3); // contributed
    for (const f of p.files?.nodes ?? []) {
      const top = f.path.includes('/') ? f.path.split('/')[0].toLowerCase() : '';
      if (top.length > 2 && !GENERIC_DIRS.has(top)) bump(dirCount, top);
    }
    const t = p.title.replace(CONV_PREFIX, '').trim();
    for (const w of t.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
      if (!STOPWORDS.has(w)) bump(kw, w);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of viewer.repositories.nodes || []) {
    bump(langCount, r.primaryLanguage?.name, 2);
  }
  // Starred repos = your interest graph.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const s of viewer.starredRepositories?.nodes || []) {
    bump(langCount, s.primaryLanguage?.name, 1);
    for (const t of topicsOf(s)) bump(topicCount, t, 2);
  }

  return {
    login: viewer.login,
    languages: [...langCount.entries()].sort(byCount).slice(0, 6),
    keywords: [...kw.entries()].sort(byCount).slice(0, 10),
    topics: [...topicCount.entries()].sort(byCount).slice(0, 8),
    dirs: [...dirCount.entries()].sort(byCount).slice(0, 5),
    prs,
  };
}

function cleanPrTitle(title: string, repoName: string): string {
  let t = title.replace(/#\d+/g, '');
  t = t.replace(CONV_PREFIX, '').trim().replace(/^:\s*/, '').trim();
  const repoTokens = new Set(
    repoName.split('/')[1]?.toLowerCase().split(/[-_/.\s]/) ?? []
  );
  const kept: string[] = [];
  for (const w of t.split(/\s+/)) {
    const wl = w.toLowerCase().replace(/[():,.'"]/g, '');
    if (repoTokens.has(wl)) continue;
    if (w.length > 1 && (/[A-Z]/.test(w.slice(1)) || w === w.toUpperCase())) continue;
    kept.push(w);
  }
  return kept.join(' ').trim();
}

export function buildQueries(profile: Profile): Query[] {
  const queries: Query[] = [];
  const [l1, l2] = profile.languages.map(([l]) => l);
  const kw = profile.keywords.map(([k]) => k);
  const topics = profile.topics.map(([t]) => t);
  const dirs = profile.dirs.map(([d]) => d);

  // 1. Best cleaned PR title (describes work you actually did).
  for (const p of profile.prs.slice(0, 6)) {
    const t = cleanPrTitle(p.title, p.repository.nameWithOwner);
    if (t.split(/\s+/).filter(Boolean).length >= 4) {
      queries.push({ text: t, lang: null, why: `your PR: '${t.slice(0, 50)}'` });
      break;
    }
  }
  // 2-4. Topic/domain-driven queries — the validated winners.
  const pool = [...topics, ...dirs];
  if (l1 && pool[0]) {
    queries.push({
      text: `${l1} ${pool[0]} ${kw.slice(0, 2).join(' ')}`.trim(),
      lang: l1,
      why: `${l1} + ${pool[0]} domain`,
    });
  }
  if (l1 && pool[1] && kw[2]) {
    queries.push({
      text: `${l1} ${pool[1]} ${kw[2]}`.trim(),
      lang: l1,
      why: `${l1} + ${pool[1]}`,
    });
  }
  if (l2 && (pool[2] || kw[3])) {
    queries.push({
      text: `${l2} ${pool[2] ?? ''} ${kw[3] ?? ''}`.trim(),
      lang: l2,
      why: `${l2} track`,
    });
  }
  // 5. Cross-language domain query (topics without language lock).
  if (topics[0] && kw[4]) {
    queries.push({
      text: `${topics[0]} ${kw[4]} ${kw[5] ?? ''}`.trim(),
      lang: null,
      why: `${topics[0]} domain, any language`,
    });
  }
  return queries.filter((q) => q.text.split(/\s+/).length >= 2).slice(0, MAX_QUERIES);
}

function ageDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

// ------------------------------------------------------------- batches

async function repoMeta(
  token: string,
  fullNames: string[]
): Promise<Map<string, { stars: number; language: string }>> {
  const names = fullNames.slice(0, 25);
  const out = new Map<string, { stars: number; language: string }>();
  if (!names.length) return out;
  const fields = names.map((fn, i) => {
    const [owner, name] = fn.split('/');
    return `r${i}: repository(owner: "${owner}", name: "${name}") { stargazerCount primaryLanguage { name } }`;
  });
  const data = await graphql(token, `{\n${fields.join('\n')}\n}`);
  names.forEach((fn, i) => {
    const n = data.data[`r${i}`];
    out.set(fn, {
      stars: n?.stargazerCount ?? 0,
      language: n?.primaryLanguage?.name ?? '',
    });
  });
  return out;
}

export interface RespInfo {
  label: string; // badge text
  delta: number; // score adjustment
}

/**
 * Maintainer responsiveness: median hours to first maintainer comment
 * across a repo's 8 newest issues. Graveyards get buried, responsive
 * repos get boosted.
 */
async function repoResponsiveness(
  token: string,
  fullNames: string[]
): Promise<Map<string, RespInfo>> {
  const names = fullNames.slice(0, MAX_RESP_REPOS);
  const out = new Map<string, RespInfo>();
  if (!names.length) return out;

  const fields = names.map((fn, i) => {
    const [owner, name] = fn.split('/');
    return `r${i}: repository(owner: "${owner}", name: "${name}") {
      issues(first: 8, states: [OPEN, CLOSED],
             orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes {
          createdAt
          comments(first: 5) { nodes { createdAt authorAssociation } }
        }
      }
    }`;
  });

  let data;
  try {
    data = await graphql(token, `{\n${fields.join('\n')}\n}`);
  } catch {
    return out; // responsiveness is a bonus signal — never fail the feed over it
  }

  names.forEach((fn, i) => {
    const issues = data.data[`r${i}`]?.issues?.nodes ?? [];
    const delays: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const iss of issues) {
      const t0 = new Date(iss.createdAt).getTime();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reply = (iss.comments?.nodes ?? []).find((c: any) =>
        MAINTAINER_ASSOC.has(c.authorAssociation)
      );
      if (reply) {
        delays.push((new Date(reply.createdAt).getTime() - t0) / 3_600_000);
      }
    }
    if (!issues.length) return;
    if (!delays.length) {
      out.set(fn, { label: 'no maintainer replies', delta: -2 });
      return;
    }
    delays.sort((a, b) => a - b);
    const med = delays[Math.floor(delays.length / 2)];
    if (med <= 72) {
      const txt = med < 24 ? `~${Math.round(med)}h` : `~${Math.round(med / 24)}d`;
      out.set(fn, { label: `responsive (${txt})`, delta: 2 });
    } else {
      out.set(fn, { label: `slow replies (~${Math.round(med / 24)}d)`, delta: 0 });
    }
  });
  return out;
}

// ------------------------------------------------------------- scoring

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function score(item: any, stars: number): [number, string[], boolean] {
  let s = 0;
  const reasons: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labels = new Set<string>((item.labels ?? []).map((l: any) => l.name.toLowerCase()));
  const days = ageDays(item.created_at);
  const comments: number = item.comments ?? 0;
  const gfi = [...labels].some((l) => l.includes('good first'));

  if (gfi) { s += 3; reasons.push('good-first-issue'); }
  if ([...labels].some((l) => l.includes('help wanted'))) {
    s += 2; reasons.push('help-wanted');
  }
  if (days <= 60) { s += 2; reasons.push(`fresh (${days}d)`); }
  else if (days <= 180) { s += 1; reasons.push(`recent (${days}d)`); }
  else { s -= 2; reasons.push(`old (${days}d)`); }
  if (comments <= 10) { s += 1; reasons.push(`quiet (${comments}c)`); }
  if (comments > 30) { s -= 2; reasons.push(`heated (${comments}c)`); }
  if (stars >= 1000) { s += 1; reasons.push('popular repo'); }
  return [s, reasons, gfi];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getFeed(token: string, opts: Options): Promise<Feed> {
  const profile = buildProfile(await graphql(token, PROFILE_QUERY));
  const queries = buildQueries(profile);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = new Map<number, { item: any; matched: Set<string> }>();
  for (const q of queries) {
    let text = `${q.text} is:issue is:open no:assignee`;
    if (q.lang) text += ` language:${q.lang}`;
    const resp = await searchIssues(token, text, PER_PAGE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const it of resp.items ?? []) {
      const login: string = it.user?.login ?? '';
      if (it.user?.type === 'Bot' || login.endsWith('[bot]')) continue;
      const entry = results.get(it.id) ?? { item: it, matched: new Set<string>() };
      entry.matched.add(q.text.slice(0, 40));
      results.set(it.id, entry);
    }
    await sleep(500); // semantic search: 10 req/min
  }

  const repoNames = [
    ...new Set(
      [...results.values()].map((r) => r.item.repository_url.split('repos/')[1] as string)
    ),
  ];
  const meta = await repoMeta(token, repoNames);

  // Pre-filter, then measure responsiveness on the repos that matter.
  const viable = repoNames.filter((fn) => (meta.get(fn)?.stars ?? 0) >= opts.minStars);
  const resp = await repoResponsiveness(token, viable);

  const matches: Match[] = [];
  for (const { item, matched } of results.values()) {
    const repoFn = item.repository_url.split('repos/')[1] as string;
    const m = meta.get(repoFn);
    if (!m || m.stars < opts.minStars) continue;
    const days = ageDays(item.created_at);
    if (days > opts.maxAgeDays) continue;

    let [s, reasons, gfi] = score(item, m.stars);
    const r = resp.get(repoFn);
    if (r) {
      s += r.delta;
      if (r.delta !== 0 || r.label.startsWith('responsive')) reasons.push(r.label);
    }
    if (matched.size >= 2) {
      s += 2;
      reasons.push(`matched ${matched.size} queries`);
    }
    matches.push({
      score: s,
      repo: repoFn,
      number: item.number,
      title: item.title,
      url: item.html_url,
      ageDays: days,
      comments: item.comments ?? 0,
      stars: m.stars,
      language: m.language,
      gfi,
      resp: r?.label ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      labels: (item.labels ?? []).map((l: any) => l.name as string).slice(0, 4),
      reasons,
      matched: [...matched].sort(),
    });
  }
  matches.sort((a, b) => b.score - a.score);

  return {
    profile,
    queries,
    matches,
    builtAt: new Date().toISOString(),
  };
}
