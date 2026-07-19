# Issue Radar

Personalized GitHub issue & project discovery in your sidebar, built on
GitHub's hybrid **semantic issue search**.

## What it does

- **Issues For You** — reads your GitHub profile (languages, merged PRs),
  generates semantic queries from your actual work, searches all public
  open+unassigned issues, filters noise (bots, repos under N stars, stale
  issues), and ranks by `good first issue` labels, freshness, and repo
  popularity. Each card shows *why* it matched you.
- **Similar Projects** — detects the repo in your workspace (via its git
  remote) and finds active repos sharing its topics/language, with
  one-click **Open** / **Clone**.

## Usage

1. Click the **radar icon** in the activity bar
2. **Sign in with GitHub** when prompted (uses the editor's built-in
   GitHub auth — no tokens to create)
3. Browse your feed. Cards open on GitHub. Feed caches for 6h;
   `Issue Radar: Refresh Feed` from the command palette rebuilds it.

## Settings

| setting | default | meaning |
|---|---|---|
| `issueRadar.minStars` | 500 | minimum repo stars for an issue to appear |
| `issueRadar.maxAgeDays` | 365 | maximum issue age (days) |

## Notes

- Semantic search is rate-limited to 10 req/min per user — the extension
  batches 5 queries per build and caches aggressively.
- Repo similarity uses topic/language repo search (repo search has no
  semantic mode; issue search does).
