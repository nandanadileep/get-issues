/**
 * Pure GitHub API helpers — no vscode imports, so this module is
 * testable from plain node (e.g. end-to-end engine tests).
 */

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000; // never hang the feed on a stalled request

async function request(
  token: string,
  method: string,
  path: string,
  body?: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'issue-radar-vscode',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new Error(`GitHub ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s (network or GitHub is slow — try Refresh)`);
    }
    throw e;
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    if (res.status === 403 || res.status === 429) {
      throw new Error(`GitHub rate limit hit (${res.status}) — wait a minute, then Refresh`);
    }
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${detail}`);
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function graphql(token: string, query: string): Promise<any> {
  const data = await request(token, 'POST', '/graphql', { query });
  if (data.errors?.length) {
    throw new Error(`GraphQL: ${JSON.stringify(data.errors[0]).slice(0, 200)}`);
  }
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function searchIssues(token: string, q: string, perPage = 10): Promise<any> {
  const params = new URLSearchParams({
    q,
    search_type: 'hybrid',
    per_page: String(perPage),
  });
  return request(token, 'GET', `/search/issues?${params}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getRepo(token: string, fullName: string): Promise<any> {
  return request(token, 'GET', `/repos/${fullName}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function searchRepos(token: string, q: string, perPage = 10): Promise<any> {
  const params = new URLSearchParams({
    q,
    sort: 'stars',
    order: 'desc',
    per_page: String(perPage),
  });
  return request(token, 'GET', `/search/repositories?${params}`);
}
