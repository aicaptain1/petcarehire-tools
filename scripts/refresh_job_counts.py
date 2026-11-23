#!/usr/bin/env python3
"""Snapshot live Pet Care Hire job counts by state and occupation.

Writes data/job_counts_YYYY-MM-DD.json and data/job_counts_compact.json.
If data/ holds an oews_mayYYYY.json from scripts/refresh_data.py, merges the
newest one with these counts and writes dist/salary_tool_payload.json (the
file the site loads from jsDelivr). Recalculate SRI hashes and tag a new
release after that file changes. Do not pin the loader to @main.

Nothing is published to the website. This only reads public listing pages.

Usage (from the repository root):
  python3 scripts/refresh_job_counts.py
"""
from __future__ import annotations

import datetime as dt
import json
import re
import time
from collections import Counter
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DIST = ROOT / "dist"
UA = (
    "PetCareHireSalaryTool/1.0 "
    "(yearly job-count snapshot for petcarehire.com; contact hello@petcarehire.com)"
)
BASE = "https://petcarehire.com/jobs"
STATES = {
    "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware",
    "District of Columbia","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa",
    "Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota",
    "Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey",
    "New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon",
    "Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah",
    "Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming","Puerto Rico",
}
OCC_CATS = {
    "29-2056": {"ids": [19673], "key": "vet_tech"},
    "31-9096": {"ids": [19674], "key": "vet_assistant"},
    "29-1131": {"ids": [19676], "key": "veterinarian"},
    "39-2021": {"ids": [19679, 19678, 19680, 19681], "key": "animal_caretaker"},
    "43-4171": {"ids": [19675], "key": "receptionist"},
}

def fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

def parse_state(text: str) -> str | None:
    for st in sorted(STATES, key=len, reverse=True):
        if f", {st}, United States" in text or f"{st}, United States" in text:
            return st
        if st == "Puerto Rico" and "Puerto Rico" in text:
            return st
    return None

def parse_cards(html: str) -> list[dict]:
    cards = re.findall(r'<li>\s*<a class="block rounded-xl border"[\s\S]*?</a>\s*</li>', html)
    out = []
    for c in cards:
        href = re.search(r'href="(/jobs/[^"]+)"', c)
        if not href or href.group(1) == "/jobs/new":
            continue
        text = re.sub(r"<[^>]+>", " ", c)
        text = re.sub(r"&amp;", "&", text)
        text = re.sub(r"\s+", " ", text)
        title_m = re.search(r"<h3[^>]*>\s*([^<]+)", c)
        title = re.sub(r"\s+", " ", title_m.group(1)).strip() if title_m else ""
        out.append({"href": href.group(1), "title": title, "state": parse_state(text), "loc_text": text[:240]})
    return out

def paginate(url: str, max_pages: int = 12) -> list[dict]:
    seen: set[tuple[str, ...]] = set()
    all_cards: list[dict] = []
    for page in range(1, max_pages + 1):
        u = url if page == 1 else url + ("&" if "?" in url else "?") + f"page={page}"
        html = fetch(u)
        cards = parse_cards(html)
        slugs = tuple(c["href"] for c in cards)
        if not cards or slugs in seen:
            break
        seen.add(slugs)
        all_cards.extend(cards)
        time.sleep(0.15)
    uniq = {c["href"]: c for c in all_cards}
    return list(uniq.values())

def main() -> int:
    all_jobs = paginate(BASE)
    by_occ = {}
    for occ, meta in OCC_CATS.items():
        params = "&".join(f"category_id%5B%5D={i}" for i in meta["ids"])
        by_occ[occ] = paginate(f"{BASE}?{params}")

    def count(cards):
        c = Counter(x["state"] for x in cards if x["state"])
        c["_unknown"] = sum(1 for x in cards if not x["state"])
        return c

    all_c, occ_c = count(all_jobs), {o: count(v) for o, v in by_occ.items()}
    today = dt.date.today().isoformat()
    by_state = {}
    for st in sorted(STATES):
        row = {"all": int(all_c.get(st, 0))}
        for occ in OCC_CATS:
            row[occ] = int(occ_c[occ].get(st, 0))
        by_state[st] = row
    snap = {
        "retrieved": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "timezone": "America/New_York",
        "source": BASE,
        "totals": {"all": len(all_jobs), **{o: len(v) for o, v in by_occ.items()}},
        "by_state": by_state,
        "unknown_or_remote": {"all": int(all_c.get("_unknown", 0)), **{o: int(occ_c[o].get("_unknown", 0)) for o in OCC_CATS}},
        "states_with_zero_jobs": [s for s, r in by_state.items() if r["all"] == 0],
        "jobs_all": [{"href": j["href"], "title": j["title"], "state": j["state"]} for j in all_jobs],
    }
    DATA.mkdir(exist_ok=True)
    (DATA / f"job_counts_{today}.json").write_text(json.dumps(snap, indent=2, ensure_ascii=False), encoding="utf-8")
    compact = {
        "as_of": today,
        "as_of_label": dt.datetime.now().astimezone().strftime("%B %-d, %Y") + " (America/New_York)",
        "source": BASE,
        "totals": snap["totals"],
        "counts": {s: {k: v for k, v in r.items() if v} for s, r in by_state.items() if r["all"]},
    }
    (DATA / "job_counts_compact.json").write_text(json.dumps(compact, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    oews_files = sorted(
        (p for p in DATA.glob("oews_may*.json") if p.is_file() and ".pretty." not in p.name),
        key=lambda p: p.name,
    )
    if oews_files:
        oews_path = oews_files[-1]
        payload = json.loads(oews_path.read_text(encoding="utf-8"))
        payload["job_counts"] = compact
        DIST.mkdir(exist_ok=True)
        out = DIST / "salary_tool_payload.json"
        out.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        print(f"Updated {out.relative_to(ROOT)} from {oews_path.name} — recompute SRI hashes before tagging.")
    print("all jobs", snap["totals"]["all"], "zero states", len(snap["states_with_zero_jobs"]))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
