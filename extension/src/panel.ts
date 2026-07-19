import * as vscode from 'vscode';
import { getToken } from './github';
import { getFeed, type Feed } from './engine';
import { findSimilar, type SimilarResult } from './similar';

const CACHE_KEY = 'issueRadar.cache';
const SAVED_KEY = 'issueRadar.saved';
const DISMISSED_KEY = 'issueRadar.dismissed';
const CACHE_TTL_MS = 6 * 3600 * 1000;
const REPO_HIDE_THRESHOLD = 2; // dismiss 2+ issues from a repo -> hide the repo

interface Cache {
  ts: number;
  feed: Feed;
  similar: SimilarResult;
}

interface SavedIssue {
  id: string; // "owner/repo#123"
  repo: string;
  number: number;
  title: string;
  url: string;
  ts: number;
}

type State =
  | { kind: 'loading' }
  | { kind: 'signin' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; cache: Cache; saved: SavedIssue[]; dismissed: string[] };

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ICON_SAVE = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2.5h9v11l-4.5-3-4.5 3z"/></svg>`;
const ICON_X = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>`;
const ICON_STAR = `<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M8 1.5l2 4.1 4.5.7-3.3 3.2.8 4.5L8 11.7 4 14l.8-4.5L1.5 6.3 6 5.6z"/></svg>`;

export class FeedProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
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

  private saved(): SavedIssue[] {
    return this.context.globalState.get<SavedIssue[]>(SAVED_KEY, []);
  }

  private dismissed(): string[] {
    return this.context.globalState.get<string[]>(DISMISSED_KEY, []);
  }

  private renderReady(cache: Cache): void {
    this.render({
      kind: 'ready',
      cache,
      saved: this.saved(),
      dismissed: this.dismissed(),
    });
  }

  private async load(force: boolean): Promise<void> {
    if (!this.view) return;
    const cached = this.context.globalState.get<Cache>(CACHE_KEY);
    if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      this.renderReady(cached);
      return;
    }

    const token = await getToken(false);
    if (!token) {
      this.render({ kind: 'signin' });
      return;
    }

    this.render({ kind: 'loading' });
    try {
      const feed = await getFeed(token, this.options());
      const similar = await findSimilar(token, feed.profile);
      const cache: Cache = { ts: Date.now(), feed, similar };
      await this.context.globalState.update(CACHE_KEY, cache);
      this.renderReady(cache);
    } catch (e) {
      if (cached) this.renderReady(cached);
      else this.render({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async onMessage(msg: {
    type: string;
    url?: string;
    id?: string;
    repo?: string;
    number?: number;
    title?: string;
  }): Promise<void> {
    const cached = this.context.globalState.get<Cache>(CACHE_KEY);
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
      case 'save': {
        if (!msg.id || !msg.url) return;
        const saved = this.saved();
        if (!saved.some((s) => s.id === msg.id)) {
          saved.unshift({
            id: msg.id,
            repo: msg.repo ?? '',
            number: msg.number ?? 0,
            title: msg.title ?? '',
            url: msg.url,
            ts: Date.now(),
          });
          await this.context.globalState.update(SAVED_KEY, saved.slice(0, 50));
        }
        if (cached) this.renderReady(cached);
        break;
      }
      case 'unsave': {
        await this.context.globalState.update(
          SAVED_KEY,
          this.saved().filter((s) => s.id !== msg.id)
        );
        if (cached) this.renderReady(cached);
        break;
      }
      case 'dismiss': {
        if (msg.id && !this.dismissed().includes(msg.id)) {
          await this.context.globalState.update(
            DISMISSED_KEY,
            [...this.dismissed(), msg.id].slice(-500)
          );
        }
        if (cached) this.renderReady(cached);
        break;
      }
      case 'resetDismissed': {
        await this.context.globalState.update(DISMISSED_KEY, []);
        if (cached) this.renderReady(cached);
        break;
      }
    }
  }

  private render(state: State): void {
    if (this.view) this.view.webview.html = this.html(state);
  }

  // ------------------------------------------------------------- html

  private html(state: State): string {
    let body = '';
    if (state.kind === 'loading') {
      body = `<div class="topbar"><span class="dim">Building your feed…</span></div>` +
        Array.from({ length: 5 }, () => '<div class="card skel"><div class="skel-line w70"></div><div class="skel-line w40"></div><div class="skel-line w90"></div></div>').join('');
    } else if (state.kind === 'signin') {
      body = `<div class="empty">
        <p><b>Issue Radar</b> finds GitHub issues matched to your actual PR history, and projects similar to what you're working on.</p>
        <button class="btn primary" data-act="signin">Sign in with GitHub</button>
      </div>`;
    } else if (state.kind === 'error') {
      body = `<div class="empty">Feed build failed:<br>${esc(state.message)}</div>
        <div class="empty"><button class="btn" data-act="refresh">Retry</button></div>`;
    } else {
      body = this.readyHtml(state.cache, state.saved, state.dismissed);
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 10px 10px 30px; font-family: var(--vscode-font-family);
         color: var(--vscode-foreground); font-size: 12px; line-height: 1.45; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .dim { color: var(--vscode-descriptionForeground, #888); }
  b { font-weight: 600; }
  .topbar { display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 8px; }
  .btn { background: var(--vscode-button-secondaryBackground, #3a3d41);
         color: var(--vscode-button-secondaryForeground, #fff);
         border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 11px; }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 8px 16px; font-size: 12px; }
  .btn:hover { opacity: 0.85; }
  .empty { text-align: center; margin-top: 48px; line-height: 1.7; }
  .profile { border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px;
             padding: 8px 10px; margin-bottom: 4px; }
  .filters { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 2px; }
  .fchip { border: 1px solid var(--vscode-panel-border, #444); border-radius: 999px;
           padding: 1px 8px; font-size: 10px; cursor: pointer; opacity: 0.7; user-select: none; }
  .fchip.on { opacity: 1; border-color: var(--vscode-focusBorder, #007fd4);
              background: var(--vscode-badge-background, #094771); color: var(--vscode-badge-foreground, #fff); }
  h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.09em;
       color: var(--vscode-descriptionForeground, #888); margin: 16px 0 6px;
       padding: 4px 0; position: sticky; top: 0;
       background: var(--vscode-sideBar-background, #181818); z-index: 1; }
  .card { position: relative; display: block; background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 6px;
          padding: 8px 10px; margin: 6px 0; cursor: pointer;
          transition: border-color 0.12s ease; }
  .card:hover { border-color: var(--vscode-focusBorder, #007fd4); }
  .card-head { display: flex; gap: 8px; align-items: flex-start; }
  .avatar { width: 20px; height: 20px; border-radius: 4px; flex: none; margin-top: 1px; }
  .t { font-size: 12.5px; font-weight: 600; line-height: 1.35;
       display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { margin-top: 3px; }
  .pill { display: inline-block; min-width: 26px; text-align: center; border-radius: 999px;
          font-size: 10px; font-weight: 700; padding: 1px 6px; margin-right: 6px; vertical-align: 1px; }
  .pill.hi { background: rgba(63, 185, 80, 0.18); color: var(--vscode-charts-green, #3fb950); }
  .pill.mid { background: rgba(210, 153, 34, 0.16); color: var(--vscode-charts-yellow, #d29922); }
  .pill.lo { background: rgba(139, 148, 158, 0.15); color: var(--vscode-descriptionForeground, #8b949e); }
  .chip { display: inline-block; border: 1px solid var(--vscode-panel-border, #444);
          border-radius: 999px; padding: 0 7px; margin: 5px 4px 0 0; font-size: 10px;
          color: var(--vscode-descriptionForeground, #999); }
  .chip.resp-ok { color: var(--vscode-charts-green, #3fb950); border-color: rgba(63,185,80,0.4); }
  .chip.resp-bad { color: var(--vscode-charts-red, #f85149); border-color: rgba(248,81,73,0.4); }
  .chip.gfi { color: var(--vscode-charts-purple, #d2a8ff); border-color: rgba(210,168,255,0.4); }
  .why { color: var(--vscode-charts-green, #73c991); margin-top: 6px; font-size: 11px; }
  .why .dim { color: var(--vscode-descriptionForeground, #888); }
  .actions { position: absolute; top: 6px; right: 6px; display: none; gap: 4px; }
  .card:hover .actions { display: flex; }
  .iconbtn { display: inline-flex; align-items: center; justify-content: center;
             width: 20px; height: 20px; border-radius: 4px; cursor: pointer;
             color: var(--vscode-descriptionForeground, #888);
             background: var(--vscode-button-secondaryBackground, #3a3d41); }
  .iconbtn:hover { color: var(--vscode-foreground); }
  .iconbtn.saved { color: var(--vscode-charts-yellow, #d29922); }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  .skel { cursor: default; }
  .skel-line { height: 10px; border-radius: 4px; margin: 6px 0;
               background: var(--vscode-panel-border, #3c3c3c);
               animation: pulse 1.2s ease-in-out infinite; }
  .w40 { width: 40%; } .w70 { width: 70%; } .w90 { width: 90%; }
  @keyframes pulse { 0%,100% { opacity: 0.45; } 50% { opacity: 1; } }
</style></head><body>${body}
<script>
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (ev) => {
    const actEl = ev.target.closest('[data-act]');
    if (actEl) {
      ev.stopPropagation();
      const d = actEl.dataset;
      vscode.postMessage({ type: d.act, url: d.url, id: d.id, repo: d.repo,
                           number: d.number ? +d.number : undefined, title: d.title });
      return;
    }
    const card = ev.target.closest('.card[data-url]');
    if (card) vscode.postMessage({ type: 'open', url: card.dataset.url });
    const fchip = ev.target.closest('.fchip');
    if (fchip) { fchip.classList.toggle('on'); applyFilters(); }
  });
  function applyFilters() {
    const active = [...document.querySelectorAll('.fchip.on')].map(c => c.dataset.f);
    const langs = active.filter(f => f.startsWith('lang:')).map(f => f.slice(5));
    document.querySelectorAll('.card.issue').forEach(card => {
      let show = true;
      if (langs.length && !langs.includes(card.dataset.lang)) show = false;
      if (active.includes('gfi') && card.dataset.gfi !== '1') show = false;
      if (active.includes('fresh') && +card.dataset.age > 30) show = false;
      card.style.display = show ? '' : 'none';
    });
    document.querySelectorAll('.tier').forEach(t => {
      const any = [...t.querySelectorAll('.card.issue')].some(c => c.style.display !== 'none');
      t.style.display = any ? '' : 'none';
    });
  }
</script>
</body></html>`;
  }

  private issueCard(m: Feed['matches'][number], savedIds: Set<string>): string {
    const id = `${m.repo}#${m.number}`;
    const owner = m.repo.split('/')[0];
    const pill = m.score >= 4 ? 'hi' : m.score >= 2 ? 'mid' : 'lo';
    const isSaved = savedIds.has(id);
    const respChip = m.resp
      ? `<span class="chip ${m.resp.startsWith('responsive') ? 'resp-ok' : 'resp-bad'}">${esc(m.resp)}</span>`
      : '';
    const chips =
      (m.gfi ? '<span class="chip gfi">good first issue</span>' : '') +
      m.labels
        .filter((l) => !l.toLowerCase().includes('good first'))
        .map((l) => `<span class="chip">${esc(l)}</span>`)
        .join('') +
      respChip;

    return `<div class="card issue tier-el" data-url="${m.url}"
      data-lang="${esc(m.language)}" data-age="${m.ageDays}" data-gfi="${m.gfi ? 1 : 0}">
  <div class="actions">
    <span class="iconbtn${isSaved ? ' saved' : ''}" title="${isSaved ? 'Saved' : 'Save'}"
      data-act="${isSaved ? 'unsave' : 'save'}" data-id="${esc(id)}" data-repo="${esc(m.repo)}"
      data-number="${m.number}" data-title="${esc(m.title)}" data-url="${m.url}">${ICON_SAVE}</span>
    <span class="iconbtn" title="Not interested"
      data-act="dismiss" data-id="${esc(id)}" data-repo="${esc(m.repo)}">${ICON_X}</span>
  </div>
  <div class="card-head">
    <img class="avatar" src="https://github.com/${esc(owner)}.png?size=40" alt="">
    <div style="min-width:0">
      <div class="t"><span class="pill ${pill}">${m.score > 0 ? '+' : ''}${m.score}</span>${esc(m.title)}</div>
      <div class="meta mono dim">${esc(m.repo)}#${m.number} · ${ICON_STAR} ${m.stars.toLocaleString()} · ${m.ageDays}d · ${m.comments}c${m.language ? ` · ${esc(m.language)}` : ''}</div>
    </div>
  </div>
  ${chips ? `<div>${chips}</div>` : ''}
  <div class="why">✓ ${esc(m.reasons.join(' · '))}<span class="dim"> — "${esc(m.matched.join('", "'))}"</span></div>
</div>`;
  }

  private readyHtml(cache: Cache, saved: SavedIssue[], dismissed: string[]): string {
    const { feed, similar } = cache;
    const p = feed.profile;
    const built = new Date(cache.ts).toLocaleString();
    const savedIds = new Set(saved.map((s) => s.id));
    const dismissedSet = new Set(dismissed);

    // repo-level feedback: hide repos dismissed repeatedly
    const repoDismissals = new Map<string, number>();
    for (const d of dismissed) {
      const repo = d.split('#')[0];
      repoDismissals.set(repo, (repoDismissals.get(repo) ?? 0) + 1);
    }
    const hiddenRepos = new Set(
      [...repoDismissals.entries()].filter(([, n]) => n >= REPO_HIDE_THRESHOLD).map(([r]) => r)
    );

    const visible = feed.matches.filter(
      (m) => !dismissedSet.has(`${m.repo}#${m.number}`) && !hiddenRepos.has(m.repo)
    );

    const tiers: [string, Feed['matches']][] = [
      ['Top picks', visible.filter((m) => m.score >= 4)],
      ['Worth a look', visible.filter((m) => m.score >= 2 && m.score < 4)],
      ['Long shots', visible.filter((m) => m.score < 2)],
    ];

    const langs = [...new Set(visible.map((m) => m.language).filter(Boolean))].slice(0, 5);
    const filterChips =
      langs.map((l) => `<span class="fchip" data-f="lang:${esc(l)}">${esc(l)}</span>`).join('') +
      `<span class="fchip" data-f="gfi">good first issue</span>` +
      `<span class="fchip" data-f="fresh">&lt;30d</span>`;

    const savedSection = saved.length
      ? `<h2>Saved (${saved.length})</h2>` +
        saved
          .slice(0, 10)
          .map(
            (s) => `<div class="card" data-url="${s.url}">
  <div class="actions"><span class="iconbtn" title="Remove" data-act="unsave" data-id="${esc(s.id)}">${ICON_X}</span></div>
  <div class="card-head">
    <img class="avatar" src="https://github.com/${esc(s.repo.split('/')[0])}.png?size=40" alt="">
    <div style="min-width:0">
      <div class="t">${esc(s.title)}</div>
      <div class="meta mono dim">${esc(s.id)}</div>
    </div>
  </div>
</div>`
          )
          .join('')
      : '';

    const dismissedNote = dismissed.length
      ? `<div class="dim" style="margin-top:6px">${dismissed.length} dismissed${hiddenRepos.size ? ` · hiding ${hiddenRepos.size} repo${hiddenRepos.size > 1 ? 's' : ''}` : ''} · <a href="#" data-act="resetDismissed" style="color:inherit">reset</a></div>`
      : '';

    const repos = similar.repos
      .map(
        (r) => `<div class="card" data-url="${r.url}">
  <div class="card-head">
    <img class="avatar" src="https://github.com/${esc(r.fullName.split('/')[0])}.png?size=40" alt="">
    <div style="min-width:0">
      <div class="t">${esc(r.fullName)}</div>
      <div class="meta mono dim">${ICON_STAR} ${r.stars.toLocaleString()}${r.language ? ` · ${esc(r.language)}` : ''}</div>
      ${r.description ? `<div class="dim" style="margin-top:3px">${esc(r.description)}</div>` : ''}
    </div>
  </div>
  <div class="row">
    <button class="btn" data-act="open" data-url="${r.url}">Open</button>
    <button class="btn" data-act="clone" data-url="${r.url}">Clone</button>
  </div>
</div>`
      )
      .join('');

    return `
<div class="topbar">
  <span class="dim">@${esc(p.login)} · ${esc(built)}</span>
  <button class="btn" data-act="refresh">↻ Refresh</button>
</div>
<div class="profile">
  <b>${esc(p.languages.map(([l]) => l).join(', '))}</b>
  ${p.topics.length ? `<div class="dim">topics: ${esc(p.topics.map(([t]) => t).join(', '))}</div>` : ''}
  <div class="dim">queries: ${feed.queries.map((q) => esc(q.text)).join(' · ')}</div>
</div>
<div class="filters">${filterChips}</div>
${savedSection}
${tiers
  .filter(([, ms]) => ms.length)
  .map(
    ([name, ms]) =>
      `<div class="tier"><h2>${name} (${ms.length})</h2>${ms
        .slice(0, 12)
        .map((m) => this.issueCard(m, savedIds))
        .join('')}</div>`
  )
  .join('') || '<div class="dim" style="margin-top:12px">No matches survived the filters — hit Refresh.</div>'}
${dismissedNote}
<h2>Similar projects</h2>
<div class="dim" style="margin-bottom:4px">${esc(similar.basis)}</div>
${repos || '<div class="dim">Open a folder with a GitHub remote for tailored suggestions.</div>'}`;
  }
}
