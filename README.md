# Issue Radar

Personalized GitHub issue discovery, built on GitHub's hybrid semantic
issue search (`/search/issues?search_type=hybrid`, GA April 2026).

Given your GitHub profile (languages, merged PRs), it generates semantic
queries, searches all public open+unassigned issues, filters noise
(bots, tiny repos, stale issues), and ranks what's left by signals like
`good first issue` labels, freshness, and repo popularity.

## Run it

```bash
cd ~/projects/issue-radar

# one time: create venv + install deps
/opt/homebrew/bin/python3.14 -m venv .venv
.venv/bin/pip install fastapi "uvicorn[standard]" jinja2 httpx

# start the web app (uses your `gh` CLI login automatically)
.venv/bin/uvicorn main:app --port 8000
```

Open http://localhost:8000 — first load takes ~15s while it builds the feed.
Refresh button (or `?refresh=1`) rebuilds; otherwise results cache for 6h.

### CLI spike (no server)

```bash
python3 spike.py   # works with system python3, uses `gh api`
```

## Auth

Resolution order: `$GITHUB_TOKEN` env var → `gh auth token`.

Any GitHub user can run this against their own profile — it always reads
the profile of whoever the token belongs to.

## Files

| file | what |
|---|---|
| `spike.py` | zero-dependency CLI prototype (validation) |
| `engine.py` | matching engine: profile → queries → search → score |
| `main.py` | FastAPI app, in-memory 6h cache |
| `templates/feed.html` | the feed UI |

## Tuning

In `engine.py`: `MIN_STARS` (repo quality floor), `MAX_AGE_DAYS`,
`PER_PAGE`, `MAX_QUERIES`, and the `score()` weights.

## Making it multi-user (deploy path)

Right now it's single-user/local. To let anyone log in:

1. Register a GitHub OAuth App (github.com/settings/developers),
   callback URL `<host>/auth/callback`
2. Add OAuth login routes (Authorization URL → callback → token in session)
3. Replace `engine.get_token()` with the session user's token
4. Per-user rate limits (10 semantic req/min) mean it scales naturally;
   add SQLite caching so repeat visits don't re-search

## Gotchas learned (don't rediscover these)

- `stars:` is NOT an issue-search qualifier — hybrid search degrades it
  into a text token. Filter stars client-side (GraphQL batch fetch).
- PR titles need repo-specific identifiers stripped before they become
  queries, or they poison the embedding (0 results).
- Over-generic queries (single common word) return 10k+ results = noise.
- Semantic/hybrid search is rate-limited to 10 req/min per token — batch
  nightly, cache aggressively, never search live per page view.
