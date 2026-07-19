/**
 * Pure GitHub API helpers — no vscode imports, so this module is
 * testable from plain node (e.g. end-to-end engine tests).
 */

const API = 'https://api.github.com';

async function request(
  token: string,
  method: string,
  path: string,
  body?: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'issue-radar-vscode',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
