/**
 * Matching engine: GitHub profile -> semantic queries -> hybrid issue search -> ranked feed.
 * TypeScript port of engine.py (validated in the spike).
 */
import { graphql, searchIssues } from './github';

const PER_PAGE = 10;
const MAX_QUERIES = 5;

const CONV_PREFIX =
  /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style)(\(.+?\))?!?\s*:\s*/i;
const STOPWORDS = new Set(
  `the a an and or of to in for on with from by at is are was were be been this that
it its as into about over after before when while not no yes add adds added adding
update updates updated updating remove removes removed fix fixes fixed use uses used
using make makes made support handle improve implement change changes bump set new`
    .split(/\s+/)
);

export interface Options {
  minStars: number;
  maxAgeDays: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Pr {
  title: string;
  repository: { nameWithOwner: string; primaryLanguage?: { name: string } | null };
  [k: string]: any;
}

export interface Profile {
  login: string;
  languages: [string, number][];
  keywords: [string, number][];
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
        repository {
          nameWithOwner
          primaryLanguage { name }
        }
      }
    }
    repositories(first: 30, ownerAffiliations: OWNER, isFork: false,
                 orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { primaryLanguage { name } }
    }
  }
}
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildProfile(data: any): Profile {
  const viewer = data.data.viewer;
  const prs: Pr[] = (viewer.pullRequests.nodes || []).filter(
    (p: Pr | null) => p && p.repository
  );

  const langCount = new Map<string, number>();
  for (const p of prs) {
    const lang = p.repository.primaryLanguage?.name;
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of viewer.repositories.nodes || []) {
    const lang = r.primaryLanguage?.name;
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 2);
  }

  const kw = new Map<string, number>();
  for (const p of prs) {
    const t = p.title.replace(CONV_PREFIX, '').trim();
    for (const w of t.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
      if (!STOPWORDS.has(w)) kw.set(w, (kw.get(w) ?? 0) + 1);
    }
  }

  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1];
  return {
    login: viewer.login,
    languages: [...langCount.entries()].sort(byCount).slice(0, 5),
    keywords: [...kw.entries()].sort(byCount).slice(0, 10),
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
  for (const p of profile.prs.slice(0, 6)) {
    const t = cleanPrTitle(p.title, p.repository.nameWithOwner);
    if (t.split(/\s+/).filter(Boolean).length >= 4) {
      queries.push({ text: t, lang: null, why: `your PR: '${t.slice(0, 60)}'` });
    }
    if (queries.length === 3) break;
  }

  const topLangs = profile.languages.map(([l]) => l);
  const topKw = profile.keywords.map(([k]) => k);
  if (topLangs.length && topKw.length >= 3) {
    queries.push({
      text: `${topLangs[0]} ${topKw.slice(0, 3).join(' ')}`,
      lang: topLangs[0],
      why: `top language ${topLangs[0]} + ${topKw.slice(0, 3).join(', ')}`,
    });
  }
  if (topLangs.length >= 2 && topKw.length >= 6) {
    queries.push({
      text: `${topLangs[1]} ${topKw.slice(3, 6).join(' ')}`,
      lang: topLangs[1],
      why: `2nd language ${topLangs[1]} + ${topKw.slice(3, 6).join(', ')}`,
    });
  }
  return queries.slice(0, MAX_QUERIES);
}

function ageDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function score(item: any, stars: Map<string, number>): [number, string[]] {
  let s = 0;
  const reasons: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labels = new Set<string>((item.labels ?? []).map((l: any) => l.name.toLowerCase()));
  const days = ageDays(item.created_at);
  const comments: number = item.comments ?? 0;
  const repoFn = item.repository_url.split('repos/')[1];
  const st = stars.get(repoFn) ?? 0;

  if ([...labels].some((l) => l.includes('good first'))) {
    s += 3; reasons.push('good-first-issue');
  }
  if ([...labels].some((l) => l.includes('help wanted'))) {
    s += 2; reasons.push('help-wanted');
  }
  if (days <= 60) { s += 2; reasons.push(`fresh (${days}d)`); }
  else if (days <= 180) { s += 1; reasons.push(`recent (${days}d)`); }
  else { s -= 2; reasons.push(`old (${days}d)`); }
  if (comments <= 10) { s += 1; reasons.push(`quiet (${comments} comments)`); }
  if (comments > 30) { s -= 2; reasons.push(`heated (${comments} comments)`); }
  if (st >= 1000) { s += 1; reasons.push(`popular repo (${st.toLocaleString()}★)`); }
  return [s, reasons];
}

async function repoStars(
  token: string,
  fullNames: string[]
): Promise<Map<string, number>> {
  const names = fullNames.slice(0, 25);
  if (!names.length) return new Map();
  const fields = names.map((fn, i) => {
    const [owner, name] = fn.split('/');
    return `r${i}: repository(owner: "${owner}", name: "${name}") { stargazerCount }`;
  });
  const data = await graphql(token, `{\n${fields.join('\n')}\n}`);
  const out = new Map<string, number>();
  names.forEach((fn, i) => {
    out.set(fn, data.data[`r${i}`]?.stargazerCount ?? 0);
  });
  return out;
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
  const stars = await repoStars(token, repoNames);

  const matches: Match[] = [];
  for (const { item, matched } of results.values()) {
    const repoFn = item.repository_url.split('repos/')[1] as string;
    const st = stars.get(repoFn) ?? 0;
    if (st < opts.minStars) continue;
    const days = ageDays(item.created_at);
    if (days > opts.maxAgeDays) continue;
    let [s, reasons] = score(item, stars);
    if (matched.size >= 2) {
      s += 2;
      reasons = [...reasons, `matched ${matched.size} queries`];
    }
    matches.push({
      score: s,
      repo: repoFn,
      number: item.number,
      title: item.title,
      url: item.html_url,
      ageDays: days,
      comments: item.comments ?? 0,
      stars: st,
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
