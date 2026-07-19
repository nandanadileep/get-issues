/**
 * "Similar projects": repos related to the repo you have open (by topics +
 * language), or derived from your profile when no workspace is open.
 */
import * as vscode from 'vscode';
import { getRepo, searchRepos } from './api';
import type { Profile } from './engine';

export interface SimilarRepo {
  fullName: string;
  description: string;
  stars: number;
  language: string;
  url: string;
  updatedAt: string;
}

export interface SimilarResult {
  basis: string; // human explanation of why these repos
  repos: SimilarRepo[];
}

/** Parse owner/repo from the first workspace folder's git origin remote. */
export async function workspaceRepo(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return null;
  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(folders[0].uri, '.git', 'config')
    );
    const text = new TextDecoder().decode(raw);
    const m = text.match(
      /url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([^\s]+?)(?:\.git)?\r?$/m
    );
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function sixMonthsAgo(): string {
  const d = new Date(Date.now() - 180 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSimilar(items: any[], exclude?: string): SimilarRepo[] {
  return items
    .filter((r) => r.full_name !== exclude)
    .slice(0, 10)
    .map((r) => ({
      fullName: r.full_name as string,
      description: (r.description ?? '').slice(0, 120),
      stars: r.stargazers_count ?? 0,
      language: r.language ?? '',
      url: r.html_url as string,
      updatedAt: r.pushed_at ?? '',
    }));
}

export async function findSimilar(
  token: string,
  profile: Profile
): Promise<SimilarResult> {
  const current = await workspaceRepo();

  if (current) {
    try {
      const repo = await getRepo(token, current);
      const topics: string[] = (repo.topics ?? []).slice(0, 3);
      const lang: string | null = repo.language ?? null;
      const parts = [
        ...topics.map((t) => `topic:${t}`),
        ...(lang ? [`language:${lang}`] : []),
        'stars:>50',
        `pushed:>${sixMonthsAgo()}`,
      ];
      if (topics.length) {
        const resp = await searchRepos(token, parts.join(' '));
        return {
          basis: `repos sharing topics with ${current}`,
          repos: toSimilar(resp.items ?? [], current),
        };
      }
    } catch {
      // fall through to profile-based
    }
  }

  const topLang = profile.languages[0]?.[0];
  const topKw = profile.keywords[0]?.[0];
  if (topLang) {
    const q = `${topKw ?? ''} language:${topLang} stars:>500 pushed:>${sixMonthsAgo()}`;
    const resp = await searchRepos(token, q.trim());
    return {
      basis: `active ${topLang} repos matching your profile`,
      repos: toSimilar(resp.items ?? []),
    };
  }
  return { basis: 'nothing to go on yet', repos: [] };
}
