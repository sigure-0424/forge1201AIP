#!/usr/bin/env python3
"""
Crawl wiki.createmod.net and minecraft.wiki using Crawl4AI 0.8.5.

Output:
- data/processed/wiki_crawl/pages.jsonl
- data/processed/wiki_crawl/failures.jsonl
- data/wiki/crawl4ai_status.md

This script is resumable and safe to run multiple times.
"""

import argparse
import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set
from urllib.parse import urldefrag, urljoin, urlparse, parse_qs

from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode

ROOT = Path.cwd()
OUT_DIR = ROOT / "data" / "processed" / "wiki_crawl"
PAGES_FILE = OUT_DIR / "pages.jsonl"
FAIL_FILE = OUT_DIR / "failures.jsonl"
STATE_FILE = OUT_DIR / "state.json"
STATUS_FILE = ROOT / "data" / "wiki" / "crawl4ai_status.md"

SEEDS = [
    "https://wiki.createmod.net/",
    "https://minecraft.wiki/",
]

ALLOWED_HOSTS = {
    "wiki.createmod.net",
    "minecraft.wiki",
}

SKIP_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".pdf",
    ".zip", ".rar", ".7z", ".mp3", ".mp4", ".webm", ".woff", ".woff2",
    ".ttf", ".otf", ".css", ".js", ".json", ".xml",
}

AD_SELECTOR = ",".join([
    "[class*='ad-']",
    "[class*='ads']",
    "[id*='ad-']",
    "[id*='ads']",
    "[class*='sponsor']",
    "[class*='banner']",
    "[class*='promo']",
    "[class*='cookie']",
    "[id*='cookie']",
    "[class*='gdpr']",
])


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_url(url: str) -> Optional[str]:
    try:
        clean, _frag = urldefrag(url.strip())
        p = urlparse(clean)
        if p.scheme not in ("http", "https"):
            return None
        host = (p.hostname or "").lower()
        if host not in ALLOWED_HOSTS:
            return None

        if p.query:
            q = parse_qs(p.query)
            if any(k in q for k in ["action", "oldid", "diff", "printable", "veaction"]):
                return None

        path = p.path or "/"
        lower_path = path.lower()
        if "special:" in lower_path or "/special:" in lower_path:
            return None

        for ext in SKIP_EXTENSIONS:
            if lower_path.endswith(ext):
                return None

        normalized = f"https://{host}{path}"
        if p.query:
            normalized = normalized + "?" + p.query
        return normalized
    except Exception:
        return None


def iter_existing_urls() -> Iterable[str]:
    if not PAGES_FILE.exists():
        return []
    urls = []
    with PAGES_FILE.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                u = obj.get("url")
                if isinstance(u, str) and u:
                    urls.append(u)
            except Exception:
                continue
    return urls


def load_state_frontier() -> List[str]:
    if not STATE_FILE.exists():
        return []
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    frontier = data.get("frontier")
    if not isinstance(frontier, list):
        return []
    out = []
    for u in frontier:
        if isinstance(u, str):
            nu = normalize_url(u)
            if nu:
                out.append(nu)
    return out


def save_state_frontier(frontier: List[str]) -> None:
    payload = {
        "updated_at": now_iso(),
        "frontier": frontier[:100000],
    }
    STATE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def extract_links(base_url: str, links_obj: Dict) -> List[str]:
    found = []
    internal = (links_obj or {}).get("internal", [])
    for item in internal:
        href = None
        if isinstance(item, dict):
            href = item.get("href")
        elif isinstance(item, str):
            href = item
        if not href:
            continue
        joined = urljoin(base_url, href)
        norm = normalize_url(joined)
        if norm:
            found.append(norm)
    return found


async def crawl(max_pages: int, max_new: int) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)

    visited: Set[str] = set(iter_existing_urls())
    queue: List[str] = load_state_frontier()
    if not queue:
        for u in SEEDS:
            nu = normalize_url(u)
            if nu:
                queue.append(nu)
        # Re-hydrate discovery when there is existing corpus but no frontier state.
        # This enables continuation across script upgrades.
        if visited:
            queue.extend(list(sorted(visited))[:120])

    # Deduplicate queue while preserving order
    seen_q = set()
    dedup_q = []
    for u in queue:
        if u in seen_q:
            continue
        seen_q.add(u)
        dedup_q.append(u)
    queue = dedup_q

    crawled_now = 0
    newly_saved = 0
    discovery_recrawls = 0
    discovery_budget = 120

    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        word_count_threshold=20,
        excluded_tags=["script", "style", "noscript", "svg", "iframe", "form", "footer", "nav"],
        excluded_selector=AD_SELECTOR,
        remove_overlay_elements=True,
        remove_consent_popups=True,
        exclude_external_links=True,
        page_timeout=45000,
        verbose=False,
    )

    with PAGES_FILE.open("a", encoding="utf-8") as pages_fp, FAIL_FILE.open("a", encoding="utf-8") as fail_fp:
        async with AsyncWebCrawler() as crawler:
            while queue and crawled_now < max_pages and newly_saved < max_new:
                url = queue.pop(0)
                already_visited = url in visited
                if already_visited and discovery_budget <= 0:
                    continue
                if not already_visited:
                    visited.add(url)
                else:
                    discovery_budget -= 1
                    discovery_recrawls += 1
                crawled_now += 1

                try:
                    res = await crawler.arun(url=url, config=run_config)
                except Exception as e:
                    fail_fp.write(json.dumps({"url": url, "error": str(e), "ts": now_iso()}, ensure_ascii=False) + "\n")
                    continue

                if not getattr(res, "success", False):
                    fail_fp.write(json.dumps({
                        "url": url,
                        "error": getattr(res, "error_message", "crawl_failed"),
                        "status_code": getattr(res, "status_code", None),
                        "ts": now_iso(),
                    }, ensure_ascii=False) + "\n")
                    continue

                markdown = (getattr(res, "markdown", "") or "").strip()
                if not already_visited and len(markdown) >= 120:
                    title = getattr(res, "title", "") or ""
                    record = {
                        "url": url,
                        "host": urlparse(url).hostname,
                        "title": title,
                        "markdown": markdown,
                        "ts": now_iso(),
                    }
                    pages_fp.write(json.dumps(record, ensure_ascii=False) + "\n")
                    newly_saved += 1

                for link in extract_links(url, getattr(res, "links", {}) or {}):
                    if link not in visited and link not in queue:
                        queue.append(link)

    save_state_frontier(queue)

    status_lines = [
        "# Crawl4AI Wiki Crawl Status",
        "",
        f"Generated at: {now_iso()}",
        "",
        "## Sources",
        "- https://wiki.createmod.net/",
        "- https://minecraft.wiki/",
        "",
        "## Result",
        f"- pages_crawled_this_run: {crawled_now}",
        f"- pages_saved_this_run: {newly_saved}",
        f"- discovery_recrawls_this_run: {discovery_recrawls}",
        f"- remaining_frontier: {len(queue)}",
        f"- corpus_file: {PAGES_FILE.relative_to(ROOT).as_posix()}",
        f"- failure_log: {FAIL_FILE.relative_to(ROOT).as_posix()}",
        f"- state_file: {STATE_FILE.relative_to(ROOT).as_posix()}",
        "",
        "## Notes",
        "- Ad/overlay/consent elements are removed via Crawl4AI selectors and popup filters.",
        "- External links are excluded; only in-domain pages are followed.",
        "- Re-run this script to continue expanding the corpus.",
    ]
    STATUS_FILE.write_text("\n".join(status_lines) + "\n", encoding="utf-8")

    print(f"[crawl-wiki] crawled={crawled_now} saved={newly_saved}")
    print(f"[crawl-wiki] corpus={PAGES_FILE}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-pages", type=int, default=400, help="Max pages to attempt per run")
    parser.add_argument("--max-new", type=int, default=300, help="Max successfully saved pages per run")
    args = parser.parse_args()

    asyncio.run(crawl(max_pages=args.max_pages, max_new=args.max_new))
