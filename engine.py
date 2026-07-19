"""
Matching engine: GitHub profile -> semantic queries -> hybrid issue search -> ranked feed.

Reuses the validated spike logic, but talks to the API directly with a token
(env GITHUB_TOKEN, or `gh auth token` as fallback) so it can run as a server.
"""

import os
import re
import subprocess
import time
from collections import Counter
from datetime import datetime, timezone

import httpx

API = "https://api.github.com"
MIN_STARS = 500
MAX_AGE_DAYS = 365
PER_PAGE = 10
MAX_QUERIES = 5

CONV_PREFIX = re.compile(
    r"^(feat|fix|chore|docs|refactor|perf|test|build|ci|style)(\(.+?\))?!?\s*:\s*", re.I
)
STOPWORDS = set("""
the a an and or of to in for on with from by at is are was were be been this that
it its as into about over after before when while not no yes add adds added adding
update updates updated updating remove removes removed fix fixes fixed use uses used
using make makes made support handle improve implement change changes bump set new
""".split())


# ------------------------------------------------------------------ auth

def get_token():
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        return tok
    r = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return r.stdout.strip()
    raise RuntimeError(
        "No GitHub token: set GITHUB_TOKEN or run `gh auth login`"
    )


# ------------------------------------------------------------------ api

class GH:
    def __init__(self, token):
        self.c = httpx.Client(
            base_url=API,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=30,
        )

    def graphql(self, query):
        r = self.c.post("/graphql", json={"query": query})
        r.raise_for_status()
        data = r.json()
        if data.get("errors"):
            raise RuntimeError(f"GraphQL errors: {data['errors'][:2]}")
        return data

    def search_issues(self, q):
        r = self.c.get(
            "/search/issues",
            params={"q": q, "search_type": "hybrid", "per_page": PER_PAGE},
        )
        r.raise_for_status()
        return r.json()


# ------------------------------------------------------------------ profile

PROFILE_QUERY = """
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
"""


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
            lang_count[lang] += 2

    keywords = Counter()
    titles = []
    for p in prs:
        t = CONV_PREFIX.sub("", p["title"]).strip()
        if len(t) >= 15:
            titles.append(t)
        for w in re.findall(r"[a-z][a-z0-9\-]{3,}", t.lower()):
            if w not in STOPWORDS:
                keywords[w] += 1

    return {
        "login": viewer["login"],
        "languages": lang_count.most_common(5),
        "keywords": keywords.most_common(10),
        "raw_prs": prs,
    }


def clean_pr_title(title, repo_name):
    t = re.sub(r"#\d+", "", title)
    t = CONV_PREFIX.sub("", t).strip().lstrip(": ").strip()
    repo_tokens = set(re.split(r"[-_/.\s]", repo_name.split("/")[-1].lower()))
    kept = []
    for w in t.split():
        wl = w.lower().strip("():,.'\"")
        if wl in repo_tokens:
            continue
        if len(w) > 1 and (re.search(r"[A-Z]", w[1:]) or w.isupper()):
            continue
        kept.append(w)
    return " ".join(kept).strip()


def build_queries(profile):
    queries = []
    for p in profile["raw_prs"][:6]:
        t = clean_pr_title(p["title"], p["repository"]["nameWithOwner"])
        if len(t.split()) >= 4:
            queries.append({"text": t, "lang": None, "why": f"your PR: '{t[:60]}'"})
        if len(queries) == 3:
            break

    top_langs = [l for l, _ in profile["languages"]]
    top_kw = [k for k, _ in profile["keywords"]]
    if top_langs and len(top_kw) >= 3:
        queries.append({
            "text": f"{top_langs[0]} {' '.join(top_kw[:3])}",
            "lang": top_langs[0],
            "why": f"top language {top_langs[0]} + {top_kw[:3]}",
        })
    if len(top_langs) >= 2 and len(top_kw) >= 6:
        queries.append({
            "text": f"{top_langs[1]} {' '.join(top_kw[3:6])}",
            "lang": top_langs[1],
            "why": f"2nd language {top_langs[1]} + {top_kw[3:6]}",
        })
    return queries[:MAX_QUERIES]


# ------------------------------------------------------------------ scoring

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
        s += 1; reasons.append(f"quiet ({comments} comments)")
    if comments > 30:
        s -= 2; reasons.append(f"heated ({comments} comments)")
    if st >= 1000:
        s += 1; reasons.append(f"popular repo ({st:,}★)")
    return s, reasons


# ------------------------------------------------------------------ feed

def repo_stars(gh, full_names):
    names = full_names[:25]
    fields = []
    for i, fn in enumerate(names):
        owner, name = fn.split("/", 1)
        fields.append(
            f'r{i}: repository(owner: "{owner}", name: "{name}") '
            "{ stargazerCount }"
        )
    if not fields:
        return {}
    data = gh.graphql("{\n" + "\n".join(fields) + "\n}")
    return {
        fn: (data["data"].get(f"r{i}") or {}).get("stargazerCount", 0)
        for i, fn in enumerate(names)
    }


def get_feed(token):
    gh = GH(token)
    profile = build_profile(gh.graphql(PROFILE_QUERY))
    queries = build_queries(profile)

    results = {}
    for q in queries:
        text = f"{q['text']} is:issue is:open no:assignee"
        if q["lang"]:
            text += f" language:{q['lang']}"
        resp = gh.search_issues(text)
        for it in resp.get("items", []):
            user = it.get("user") or {}
            if user.get("type") == "Bot" or user.get("login", "").endswith("[bot]"):
                continue
            results.setdefault(it["id"], (it, set()))[1].add(q["text"][:40])
        time.sleep(0.5)

    repo_names = list({
        it["repository_url"].split("repos/", 1)[-1] for it, _ in results.values()
    })
    stars = repo_stars(gh, repo_names)

    matches = []
    for it, matched in results.values():
        repo_fn = it["repository_url"].split("repos/", 1)[-1]
        if stars.get(repo_fn, 0) < MIN_STARS:
            continue
        if age_days(it["created_at"]) > MAX_AGE_DAYS:
            continue
        s, reasons = score(it, stars)
        if len(matched) >= 2:
            s += 2; reasons.append(f"matched {len(matched)} queries")
        matches.append({
            "score": s,
            "repo": repo_fn,
            "number": it["number"],
            "title": it["title"],
            "url": it["html_url"],
            "age_days": age_days(it["created_at"]),
            "comments": it.get("comments", 0),
            "stars": stars.get(repo_fn, 0),
            "labels": [l["name"] for l in it.get("labels", [])][:4],
            "reasons": reasons,
            "matched": sorted(matched),
        })
    matches.sort(key=lambda m: -m["score"])

    return {
        "profile": profile,
        "queries": queries,
        "matches": matches,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
