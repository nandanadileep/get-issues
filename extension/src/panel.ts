import * as vscode from 'vscode';
import { getToken } from './github';
import { getFeed, type Feed } from './engine';
import { findSimilar, type SimilarResult } from './similar';

const CACHE_KEY = 'issueRadar.cache';
const CACHE_TTL_MS = 6 * 3600 * 1000;

interface Cache {
  ts: number;
  feed: Feed;
  similar: SimilarResult;
}

type State =
  | { kind: 'loading' }
  | { kind: 'signin' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; cache: Cache };

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class FeedProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.render({ kind: 'loading' });
    void this.load(false);
  }

  refresh(): void {
    void this.load(true);
  }

  private options() {
    const cfg = vscode.workspace.getConfiguration('issueRadar');
    return {
      minStars: cfg.get<number>('minStars', 500),
      maxAgeDays: cfg.get<number>('maxAgeDays', 365),
    };
  }

  private async load(force: boolean): Promise<void> {
    if (!this.view) return;
    const cached = this.context.globalState.get<Cache>(CACHE_KEY);
    if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      this.render({ kind: 'ready', cache: cached });
      return;
    }

    const token = await getToken(false);
    if (!token) {
      this.render({ kind: 'signin' });
      return;
    }

    this.render({ kind: 'loading' });
    try {
      const opts = this.options();
      const feed = await getFeed(token, opts);
      const similar = await findSimilar(token, feed.profile);
      const cache: Cache = { ts: Date.now(), feed, similar };
      await this.context.globalState.update(CACHE_KEY, cache);
      this.render({ kind: 'ready', cache });
    } catch (e) {
      if (cached) {
        this.render({ kind: 'ready', cache: cached });
      } else {
        this.render({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private async onMessage(msg: { type: string; url?: string }): Promise<void> {
    switch (msg.type) {
      case 'refresh':
        this.refresh();
        break;
      case 'signin': {
        const token = await getToken(true);
        if (token) this.refresh();
        break;
      }
      case 'open':
        if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'clone':
        if (msg.url) vscode.commands.executeCommand('git.clone', msg.url);
        break;
    }
  }

  private render(state: State): void {
    if (this.view) this.view.webview.html = this.html(state);
  }

  private html(state: State): string {
    let body = '';
    if (state.kind === 'loading') {
      body = `<div class="empty">Building your feed…<br><span class="dim">~15s while GitHub searches semantically</span></div>`;
    } else if (state.kind === 'signin') {
      body = `<div class="empty">
        <p>Issue Radar builds a feed of GitHub issues matched to your actual PR history.</p>
        <button class="btn primary" onclick="send({type:'signin'})">Sign in with GitHub</button>
      </div>`;
    } else if (state.kind === 'error') {
      body = `<div class="empty">Feed build failed:<br>${esc(state.message)}</div>
        <div class="empty"><button class="btn" onclick="send({type:'refresh'})">Retry</button></div>`;
    } else {
      body = this.readyHtml(state.cache);
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 10px; font-family: var(--vscode-font-family);
         color: var(--vscode-foreground); font-size: 12px; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .dim { opacity: 0.65; }
  .empty { text-align: center; margin-top: 40px; line-height: 1.6; }
  .btn { background: var(--vscode-button-secondaryBackground, #3a3d41);
         color: var(--vscode-button-secondaryForeground, #fff);
         border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 11px; }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 8px 16px; font-size: 12px; }
  .btn:hover { opacity: 0.85; }
  .profile { border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px;
             padding: 8px 10px; margin-bottom: 10px; line-height: 1.5; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
       opacity: 0.7; margin: 14px 0 6px; }
  .card { display: block; width: 100%; text-align: left; background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px;
          padding: 8px 10px; margin: 6px 0; cursor: pointer; color: inherit; font: inherit; }
  .card:hover { border-color: var(--vscode-focusBorder, #007fd4); }
  .t { font-weight: 600; line-height: 1.35; }
  .meta { opacity: 0.65; margin-top: 2px; }
  .why { color: var(--vscode-testing-iconPassed, #73c991); margin-top: 5px; line-height: 1.4; }
  .chip { display: inline-block; border: 1px solid var(--vscode-panel-border, #444);
          border-radius: 999px; padding: 0 7px; margin: 4px 4px 0 0; font-size: 10px; opacity: 0.8; }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  .score { font-weight: 700; color: var(--vscode-testing-iconPassed, #73c991); margin-right: 6px; }
  .score.neg { color: inherit; opacity: 0.5; }
</style></head><body>${body}
<script>
  const vscode = acquireVsCodeApi();
  function send(m) { vscode.postMessage(m); }
</script>
</body></html>`;
  }

  private readyHtml(cache: Cache): string {
    const { feed, similar } = cache;
    const p = feed.profile;
    const built = new Date(cache.ts).toLocaleString();

    const issues = feed.matches
      .slice(0, 25)
      .map((m) => {
        const chips = m.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join('');
        return `<button class="card" onclick="send({type:'open',url:'${m.url}'})">
  <div class="t"><span class="score${m.score <= 0 ? ' neg' : ''}">${m.score > 0 ? '+' : ''}${m.score}</span>${esc(m.title)}</div>
  <div class="meta">${esc(m.repo)}#${m.number} · ${m.stars.toLocaleString()}★ · ${m.ageDays}d · ${m.comments} comments</div>
  ${chips}
  <div class="why">✓ ${esc(m.reasons.join(' · '))}<span class="dim"> — "${esc(m.matched.join('", "'))}"</span></div>
</button>`;
      })
      .join('');

    const repos = similar.repos
      .map(
        (r) => `<div class="card">
  <div class="t">${esc(r.fullName)} <span class="dim">${r.stars.toLocaleString()}★ ${esc(r.language)}</span></div>
  <div class="meta">${esc(r.description)}</div>
  <div class="row">
    <button class="btn" onclick="send({type:'open',url:'${r.url}'})">Open</button>
    <button class="btn" onclick="send({type:'clone',url:'${r.url}'})">Clone</button>
  </div>
</div>`
      )
      .join('');

    return `
<div class="topbar">
  <span class="dim">@${esc(p.login)} · built ${esc(built)}</span>
  <button class="btn" onclick="send({type:'refresh'})">↻ Refresh</button>
</div>
<div class="profile">
  <b>${esc(p.languages.map(([l]) => l).join(', '))}</b>
  <div class="dim">queries: ${feed.queries.map((q) => esc(q.text)).join(' · ')}</div>
</div>
<h2>Issues for you (${feed.matches.length})</h2>
${issues || '<div class="dim">No matches survived the filters — hit Refresh.</div>'}
<h2>Similar projects</h2>
<div class="dim" style="margin-bottom:4px">${esc(similar.basis)}</div>
${repos || '<div class="dim">Open a folder with a GitHub remote for tailored suggestions.</div>'}`;
  }
}
