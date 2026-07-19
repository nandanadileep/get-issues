#!/usr/bin/env python3
"""
Spike: given your GitHub profile, does GitHub's hybrid semantic issue search
return issues you'd plausibly solve?

Steps:
  1. Pull viewer's merged PRs + owned repo languages (GraphQL)
  2. Build a skill profile and generate semantic queries from real PR titles
  3. Run hybrid searches via /search/issues?search_type=hybrid
  4. Score results (labels, freshness, activity, repo stars) and rank
"""

import json
import re
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone


def gh_api(args):
    """Call gh api, return parsed JSON."""
    r = subprocess.run(["gh", "api"] + args, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"gh api failed: {' '.join(args[:2])}\n{r.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(r.stdout)


def gh_graphql(query):
    return gh_api(["graphql", "-f", f"query={query}"])


# ---------------------------------------------------------------- profile

PROFILE_QUERY = """
{
  viewer {
    login
    pullRequests(first: 50, states: MERGED,
                 orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        title
        updatedAt
        repository {
          nameWithOwner
          stargazerCount
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
"""

CONV_PREFIX = re.compile(r"^(feat|fix|chore|docs|refactor|perf|test|build|ci|style)(\(.+?\))?!?\s*:\s*", re.I)
STOPWORDS = set("""
the a an and or of to in for on with from by at is are was were be been this that
it its as into about over after before when while not no yes add adds added adding
update updates updated updating remove removes removed fix fixes fixed use uses used
using make makes made support handle improve implement change changes bump set new
""".split())


def build_profile(data):
    viewer = data["data"]["viewer"]
    prs = [p for p in viewer["pullRequests"]["nodes"] if p and p.get("repository")]

    lang_count = Counter()
    for p in prs:
        lang = (p["repository"].get("primaryLanguage") or {}).get("name")
        if lang:
            lang_count[lang] += 1
    for r in viewer["repositories"]["nodes"]:
        lang = (r.get("primaryLanguage") or {}).get("name")
        if lang:
            lang_count[lang] += 2  # own repos weigh more

    contrib_repos = Counter()
    for p in prs:
        contrib_repos[p["repository"]["nameWithOwner"]] += 1

    titles = []
    for p in prs:
        t = CONV_PREFIX.sub("", p["title"]).strip()
        if len(t) >= 15:
            titles.append(t)

    keywords = Counter()
    for t in titles:
        for w in re.findall(r"[a-z][a-z0-9\-]{3,}", t.lower()):
            if w not in STOPWORDS:
                keywords[w] += 1

    return {
        "login": viewer["login"],
        "languages": lang_count,
        "contrib_repos": contrib_repos,
        "pr_titles": titles,
        "keywords": keywords,
        "raw_prs": prs,
    }


def clean_pr_title(title, repo_name):
    """Strip repo-specific vocabulary that poisons semantic search."""
    t = re.sub(r"#\d+", "", title)                    # issue refs
    t = CONV_PREFIX.sub("", t).strip()                # leftover 'Fix #7:' -> 'Fix' prefix
    t = t.lstrip(": ").strip()
    repo_tokens = set(re.split(r"[-_/.\s]", repo_name.split("/")[-1].lower()))
    words = t.split()
    kept = []
    for w in words:
        wl = w.lower().strip("():,.'\"")
        if wl in repo_tokens:                          # repo-specific names
            continue
        if re.search(r"[A-Z]", w[1:]) or w.isupper():  # camelCase / ACRONYMS = identifiers
            continue
        kept.append(w)
    return " ".join(kept).strip()


def build_queries(profile, prs):
    """5 queries: 3 from real PR titles, 2 from language+keyword combos."""
    queries = []

    # From real merged PR titles — these describe work you actually did,
    # but only after removing repo-specific vocabulary.
    for p in prs[:6]:
        t = clean_pr_title(CONV_PREFIX.sub("", p["title"]).strip(),
                           p["repository"]["nameWithOwner"])
        if len(t.split()) >= 4:
            queries.append({"text": t, "lang": None, "why": f"your PR: '{t[:60]}'"})
        if len(queries) == 3:
            break

    top_langs = [l for l, _ in profile["languages"].most_common(3)]
    top_kw = [k for k, _ in profile["keywords"].most_common(8)]

    if top_langs and len(top_kw) >= 2:
        queries.append({
            "text": f"{top_langs[0]} {' '.join(top_kw[:3])}",
            "lang": top_langs[0],
            "why": f"top language {top_langs[0]} + keywords {top_kw[:3]}",
        })
    if len(top_langs) >= 2 and len(top_kw) >= 5:
        queries.append({
            "text": f"{top_langs[1]} {' '.join(top_kw[3:6])}",
            "lang": top_langs[1],
            "why": f"2nd language {top_langs[1]} + keywords {top_kw[3:6]}",
        })
    return queries[:5]


# ---------------------------------------------------------------- search

def search_issues(query):
    q = f"{query['text']} is:issue is:open no:assignee"
    if query["lang"]:
        q += f" language:{query['lang']}"
    return gh_api([
        "search/issues", "-X", "GET",
        "-f", f"q={q}",
        "-f", "search_type=hybrid",
        "-f", "per_page=10",
    ])


def repo_stars(full_names):
    """Batch-fetch stargazer counts for up to 20 repos in one GraphQL call."""
    fields = []
    for i, fn in enumerate(full_names[:20]):
        owner, name = fn.split("/", 1)
        fields.append(
            f'r{i}: repository(owner: "{owner}", name: "{name}") '
            "{ stargazerCount }"
        )
    if not fields:
        return {}
    data = gh_graphql("{\n" + "\n".join(fields) + "\n}")
    out = {}
    for i, fn in enumerate(full_names[:20]):
        node = data["data"].get(f"r{i}")
        out[fn] = node["stargazerCount"] if node else 0
    return out


def age_days(iso):
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - dt).days


def score(item, stars):
    s, reasons = 0, []
    labels = {l["name"].lower() for l in item.get("labels", [])}
    days = age_days(item["created_at"])
    comments = item.get("comments", 0)
    repo_fn = item["repository_url"].split("repos/", 1)[-1]
    st = stars.get(repo_fn, 0)

    if any("good first" in l for l in labels):
        s += 3; reasons.append("good-first-issue")
    if any("help wanted" in l for l in labels):
        s += 2; reasons.append("help-wanted")
    if days <= 60:
        s += 2; reasons.append(f"fresh ({days}d)")
    elif days <= 180:
        s += 1; reasons.append(f"recent ({days}d)")
    else:
        s -= 2; reasons.append(f"old ({days}d)")
    if comments <= 10:
        s += 1; reasons.append(f"quiet ({comments}c)")
    if comments > 30:
        s -= 2; reasons.append(f"swamp ({comments}c)")
    if st >= 1000:
        s += 1; reasons.append(f"popular repo ({st}*)")
    elif st < 50:
        s -= 3; reasons.append(f"tiny repo ({st}*)")
    return s, reasons


# ---------------------------------------------------------------- main

def main():
    print("== fetching profile ==")
    data = gh_graphql(PROFILE_QUERY)
    profile = build_profile(data)
    print(f"user:        {profile['login']}")
    print(f"languages:   {profile['languages'].most_common(5)}")
    print(f"contributed: {profile['contrib_repos'].most_common(5)}")
    print(f"keywords:    {profile['keywords'].most_common(10)}")

    queries = build_queries(profile, profile["raw_prs"])
    print("\n== queries ==")
    for q in queries:
        print(f"  [{q['text']!r} lang={q['lang']}]  <- {q['why']}")

    results = {}  # issue id -> (item, matched queries)
    print("\n== searching (hybrid) ==")
    for q in queries:
        resp = search_issues(q)
        meta = {k: v for k, v in resp.items()
                if k not in ("items", "incomplete_results", "total_count")}
        if meta:
            print(f"  search metadata: {meta}")
        items = resp.get("items", [])
        print(f"  {q['text'][:50]!r}: {resp.get('total_count')} total, "
              f"{len(items)} returned")
        for it in items:
            user = it.get("user") or {}
            if user.get("type") == "Bot" or user.get("login", "").endswith("[bot]"):
                continue  # skip bot-filed noise
            results.setdefault(it["id"], (it, set()))[1].add(q["text"][:40])
        time.sleep(1)  # stay well under 10 req/min

    repo_names = list({
        it["repository_url"].split("repos/", 1)[-1]
        for it, _ in results.values()
    })
    print(f"\n== fetching stars for {len(repo_names)} repos ==")
    stars = repo_stars(repo_names)

    MIN_STARS = 500
    MAX_AGE_DAYS = 365
    scored = []
    for it, matched in results.values():
        repo_fn = it["repository_url"].split("repos/", 1)[-1]
        if stars.get(repo_fn, 0) < MIN_STARS:
            continue  # hard filter: repos too small to trust triage
        if age_days(it["created_at"]) > MAX_AGE_DAYS:
            continue  # hard filter: stale issue
        s, reasons = score(it, stars)
        if len(matched) >= 2:
            s += 2; reasons.append(f"matched {len(matched)} queries")
        scored.append((s, it, reasons, matched))
    scored.sort(key=lambda x: -x[0])

    print("\n== TOP MATCHES ==")
    for s, it, reasons, matched in scored[:15]:
        repo = it["repository_url"].split("repos/", 1)[-1]
        days = age_days(it["created_at"])
        print(f"\n[{s:+d}] {repo}#{it['number']} ({days}d old, "
              f"{it.get('comments', 0)} comments)")
        print(f"     {it['title'][:100]}")
        print(f"     why: {', '.join(reasons)}")
        print(f"     matched: {'; '.join(sorted(matched))[:80]}")
        print(f"     {it['html_url']}")


if __name__ == "__main__":
    main()
