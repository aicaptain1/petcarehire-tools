#!/usr/bin/env python3
"""Refresh Pet Care Hire salary-tool data from official BLS OEWS files.

Downloads the latest (or a pinned) Occupational Employment and Wage Statistics
bulk workbooks from bls.gov, keeps only the five pet-care occupations used by
the calculator, and writes cleaned CSV + compact JSON under data/ (repository root).

BLS blocks anonymous clients with HTTP 403. This script sends an identifying
User-Agent. Do not impersonate a browser.

Usage (from the repository root):
  python3 scripts/refresh_data.py
  python3 scripts/refresh_data.py --year 2025
  python3 scripts/refresh_data.py --from-cache /tmp/oews

Then run scripts/refresh_job_counts.py. That merges the newest
data/oews_mayYYYY.json with live job counts and writes
dist/salary_tool_payload.json, which is the file the site loads.

Never invents numbers. BLS suppression / cap flags (*, **, #, ~) become null
in JSON and blank in CSV (the tool displays them as n/a).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

try:
    import pandas as pd
except ImportError:
    sys.exit("This script needs pandas and openpyxl. Install with: pip install pandas openpyxl")

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

# May 2025 is the current OEWS vintage as of this draft (released May 15, 2026).
DEFAULT_YEAR = 2025

SOURCE_PAGE = "https://www.bls.gov/oes/tables.htm"
SPECIAL_REQUESTS = "https://www.bls.gov/oes/special-requests"
# Official methodology / technical notes for the May 2025 release.
TECHNICAL_NOTES = "https://www.bls.gov/oes/current/oes_tec.htm"
CITATION = "U.S. Bureau of Labor Statistics, Occupational Employment and Wage Statistics, May {year}"

# Identifying UA is required. A generic or empty UA gets HTTP 403.
USER_AGENT = (
    "PetCareHireSalaryTool/1.0 "
    "(yearly OEWS refresh for petcarehire.com; contact hello@petcarehire.com)"
)

OCCUPATIONS = {
    "29-2056": {
        "bls_title": "Veterinary Technologists and Technicians",
        "label": "Veterinary technician (vet tech)",
        "short": "Veterinary technician",
        "job_label": "vet tech",
        "category_ids": [19673],
        "note": None,
    },
    "31-9096": {
        "bls_title": "Veterinary Assistants and Laboratory Animal Caretakers",
        "label": "Veterinary assistant",
        "short": "Veterinary assistant",
        "job_label": "veterinary assistant",
        "category_ids": [19674],
        "note": "BLS groups veterinary assistants with laboratory animal caretakers in this occupation.",
    },
    "29-1131": {
        "bls_title": "Veterinarians",
        "label": "Veterinarian (DVM)",
        "short": "Veterinarian",
        "job_label": "veterinarian",
        "category_ids": [19676],
        "note": None,
    },
    "39-2021": {
        "bls_title": "Animal Caretakers",
        "label": "Animal caretaker (groomer, kennel, walker)",
        "short": "Animal caretaker",
        "job_label": "grooming, kennel and pet-care",
        "category_ids": [19679, 19678, 19680, 19681],
        "note": (
            "BLS groups groomers, kennel staff, dog walkers, pet sitters and similar "
            "roles as animal caretakers. This is not a groomer-only wage."
        ),
    },
    "43-4171": {
        "bls_title": "Receptionists and Information Clerks",
        "label": "Receptionist (all industries)",
        "short": "Receptionist",
        "job_label": "veterinary receptionist",
        "category_ids": [19675],
        "note": (
            "This is the official BLS wage for receptionists and information clerks "
            "across all industries, not veterinary receptionists only. Clinic pay may differ."
        ),
    },
}

# display_order in the widget
OCC_ORDER = ["29-2056", "31-9096", "29-1131", "39-2021", "43-4171"]

# 50 states + DC use "{slug}-united-states". Puerto Rico is just "puerto-rico"
# (verified Nov 23, 2026: puerto-rico-united-states falls back to all jobs).
STATE_JOB_SLUGS = {
    "Alabama": "alabama-united-states",
    "Alaska": "alaska-united-states",
    "Arizona": "arizona-united-states",
    "Arkansas": "arkansas-united-states",
    "California": "california-united-states",
    "Colorado": "colorado-united-states",
    "Connecticut": "connecticut-united-states",
    "Delaware": "delaware-united-states",
    "District of Columbia": "district-of-columbia-united-states",
    "Florida": "florida-united-states",
    "Georgia": "georgia-united-states",
    "Hawaii": "hawaii-united-states",
    "Idaho": "idaho-united-states",
    "Illinois": "illinois-united-states",
    "Indiana": "indiana-united-states",
    "Iowa": "iowa-united-states",
    "Kansas": "kansas-united-states",
    "Kentucky": "kentucky-united-states",
    "Louisiana": "louisiana-united-states",
    "Maine": "maine-united-states",
    "Maryland": "maryland-united-states",
    "Massachusetts": "massachusetts-united-states",
    "Michigan": "michigan-united-states",
    "Minnesota": "minnesota-united-states",
    "Mississippi": "mississippi-united-states",
    "Missouri": "missouri-united-states",
    "Montana": "montana-united-states",
    "Nebraska": "nebraska-united-states",
    "Nevada": "nevada-united-states",
    "New Hampshire": "new-hampshire-united-states",
    "New Jersey": "new-jersey-united-states",
    "New Mexico": "new-mexico-united-states",
    "New York": "new-york-united-states",
    "North Carolina": "north-carolina-united-states",
    "North Dakota": "north-dakota-united-states",
    "Ohio": "ohio-united-states",
    "Oklahoma": "oklahoma-united-states",
    "Oregon": "oregon-united-states",
    "Pennsylvania": "pennsylvania-united-states",
    "Rhode Island": "rhode-island-united-states",
    "South Carolina": "south-carolina-united-states",
    "South Dakota": "south-dakota-united-states",
    "Tennessee": "tennessee-united-states",
    "Texas": "texas-united-states",
    "Utah": "utah-united-states",
    "Vermont": "vermont-united-states",
    "Virginia": "virginia-united-states",
    "Washington": "washington-united-states",
    "West Virginia": "west-virginia-united-states",
    "Wisconsin": "wisconsin-united-states",
    "Wyoming": "wyoming-united-states",
    "Puerto Rico": "puerto-rico",
}

# Core UI list is 50 states + DC. PR is included in the dropdown after them
# because OEWS publishes the pet-care occupations there. Guam and the
# Virgin Islands stay in the data files only.
UI_AREAS = set(STATE_JOB_SLUGS)  # names

VALUE_COLS = [
    "employment",
    "hourly_mean",
    "annual_mean",
    "hourly_p10",
    "hourly_p25",
    "hourly_median",
    "hourly_p75",
    "hourly_p90",
    "annual_p10",
    "annual_p25",
    "annual_median",
    "annual_p75",
    "annual_p90",
]

BLS_COLS = {
    "TOT_EMP": "employment",
    "H_MEAN": "hourly_mean",
    "A_MEAN": "annual_mean",
    "H_PCT10": "hourly_p10",
    "H_PCT25": "hourly_p25",
    "H_MEDIAN": "hourly_median",
    "H_PCT75": "hourly_p75",
    "H_PCT90": "hourly_p90",
    "A_PCT10": "annual_p10",
    "A_PCT25": "annual_p25",
    "A_MEDIAN": "annual_median",
    "A_PCT75": "annual_p75",
    "A_PCT90": "annual_p90",
}

# Flags BLS uses instead of a number. Never convert these to 0 or a guess.
SUPPRESSED = {"*", "**", "#", "~"}

INT_FIELDS = {
    "employment",
    "annual_mean",
    "annual_p10",
    "annual_p25",
    "annual_median",
    "annual_p75",
    "annual_p90",
}


def parse_value(raw: Any, integer: bool) -> int | float | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if text == "" or text.lower() in {"nan", "none"} or text in SUPPRESSED:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    if integer:
        return int(round(number))
    # Keep hourly wages at two decimals, as BLS publishes them.
    return round(number, 2)


def parse_states_from_metro_title(title: str) -> list[str]:
    """Parse 'New York-Newark-Jersey City, NY-NJ-PA' -> ['NY', 'NJ', 'PA']."""
    match = re.search(r",\s*([A-Z]{2}(?:-[A-Z]{2})*)\s*$", title or "")
    if not match:
        return []
    return match.group(1).split("-")


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url} -> {dest}", flush=True)
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urlopen(req, timeout=120) as resp:
        data = resp.read()
        content_type = resp.headers.get("Content-Type", "")
    if len(data) < 1000 or b"PK" != data[:2]:
        raise RuntimeError(
            f"Download did not look like a zip (type={content_type}, bytes={len(data)}). "
            "BLS often returns 403 without an identifying User-Agent."
        )
    dest.write_bytes(data)
    print(f"  saved {len(data):,} bytes", flush=True)
    return dest


def extract_xlsx(zip_path: Path, name_contains: str) -> Path:
    with zipfile.ZipFile(zip_path) as zf:
        matches = [
            n
            for n in zf.namelist()
            if n.lower().endswith(".xlsx") and name_contains.lower() in n.lower()
        ]
        if not matches:
            raise RuntimeError(f"No xlsx matching {name_contains!r} in {zip_path.name}: {zf.namelist()}")
        # Prefer the data workbook, not file_descriptions.
        matches = [n for n in matches if "file_description" not in n.lower()] or matches
        name = matches[0]
        out = zip_path.parent / Path(name).name
        out.write_bytes(zf.read(name))
        return out


def load_workbook(path: Path, cols: list[str] | None = None) -> pd.DataFrame:
    print(f"Reading {path.name} ...", flush=True)
    return pd.read_excel(path, dtype=str, usecols=cols)


def filter_occupations(df: pd.DataFrame) -> pd.DataFrame:
    keep = df["OCC_CODE"].isin(OCCUPATIONS) & (df["O_GROUP"].str.lower() == "detailed")
    # National / state / metro files include only cross-industry all-ownership
    # rows for these tables, but be conservative if extra industry rows appear.
    if "NAICS" in df.columns:
        keep = keep & df["NAICS"].isin(["000000", "000000.0"]) | (
            df["OCC_CODE"].isin(OCCUPATIONS)
            & (df["O_GROUP"].str.lower() == "detailed")
            & df["NAICS"].isna()
        )
        # Recompute cleanly:
        keep = (
            df["OCC_CODE"].isin(OCCUPATIONS)
            & (df["O_GROUP"].str.lower() == "detailed")
            & df["NAICS"].fillna("000000").isin(["000000", "000000.0"])
        )
    return df.loc[keep].copy()


def area_id(area: str, area_type: str) -> str:
    """Stable ids: 'US', zero-padded 2-digit state FIPS, or metro AREA as published."""
    a = str(area).strip()
    if area_type == "national" or a in {"99", "0000000", "0000099"}:
        return "US"
    if area_type == "state":
        return a.zfill(2)
    # Metro AREA is typically a 5-digit CBSA (or 7 with leading zeros).
    return a.lstrip("0") or a


def row_from_bls(r: pd.Series, area_type: str) -> dict[str, Any]:
    title = str(r.get("AREA_TITLE") or "").strip()
    prim = str(r.get("PRIM_STATE") or "").strip().upper()
    at = area_type
    aid = area_id(str(r.get("AREA")), at)
    rec: dict[str, Any] = {
        "occ_code": str(r["OCC_CODE"]).strip(),
        "area_id": aid,
        "area_type": at,
        "area_title": "United States" if aid == "US" else title,
        "prim_state": "" if aid == "US" else prim,
        "states": [],
        "place_slug": None,
    }
    if at == "state":
        rec["states"] = [prim] if prim and prim != "US" else []
        rec["place_slug"] = STATE_JOB_SLUGS.get(rec["area_title"])
    elif at == "metro":
        rec["states"] = parse_states_from_metro_title(title) or ([prim] if prim else [])
    for bls_col, name in BLS_COLS.items():
        rec[name] = parse_value(r.get(bls_col), integer=(name in INT_FIELDS))
    return rec


def collect(nat: pd.DataFrame, st: pd.DataFrame, msa: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, r in filter_occupations(nat).iterrows():
        rows.append(row_from_bls(r, "national"))
    for _, r in filter_occupations(st).iterrows():
        rows.append(row_from_bls(r, "state"))
    for _, r in filter_occupations(msa).iterrows():
        # MSA workbook is AREA_TYPE 4 (metropolitan statistical areas) only.
        rows.append(row_from_bls(r, "metro"))
    return rows


def build_areas(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    areas: dict[str, dict[str, Any]] = {}
    for rec in rows:
        aid = rec["area_id"]
        if aid in areas:
            continue
        areas[aid] = {
            "id": aid,
            "name": rec["area_title"],
            "type": rec["area_type"],
            "prim_state": rec["prim_state"] or None,
            "states": rec["states"],
            "place_slug": rec["place_slug"],
            "in_ui": rec["area_type"] == "national"
            or (rec["area_type"] == "state" and rec["area_title"] in UI_AREAS)
            or rec["area_type"] == "metro",
        }
        # Hide Guam / Virgin Islands from the default state dropdown.
        if rec["area_type"] == "state" and rec["area_title"] not in UI_AREAS:
            areas[aid]["in_ui"] = False
    # National first, then states A-Z, metros stay grouped by state in the UI.
    return areas


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = [
        "occ_code",
        "occ_title",
        "area_id",
        "area_type",
        "area_title",
        "prim_state",
        "states",
        "place_slug",
        *VALUE_COLS,
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for rec in rows:
            out = {k: rec.get(k, "") for k in fieldnames}
            out["occ_title"] = OCCUPATIONS[rec["occ_code"]]["bls_title"]
            out["states"] = "|".join(rec.get("states") or [])
            for k in VALUE_COLS:
                if out[k] is None:
                    out[k] = ""
            w.writerow(out)


def write_json(path: Path, rows: list[dict[str, Any]], areas: dict[str, Any], meta: dict[str, Any]) -> None:
    # Compact wage rows: [occ, area, emp, hmean, amean, h10, h25, hmed, h75, h90, a10, a25, amed, a75, a90]
    compact_rows = []
    for rec in rows:
        compact_rows.append(
            [
                rec["occ_code"],
                rec["area_id"],
                rec["employment"],
                rec["hourly_mean"],
                rec["annual_mean"],
                rec["hourly_p10"],
                rec["hourly_p25"],
                rec["hourly_median"],
                rec["hourly_p75"],
                rec["hourly_p90"],
                rec["annual_p10"],
                rec["annual_p25"],
                rec["annual_median"],
                rec["annual_p75"],
                rec["annual_p90"],
            ]
        )
    payload = {
        "meta": meta,
        "occupations": {code: {**OCCUPATIONS[code], "order": i} for i, code in enumerate(OCC_ORDER)},
        "areas": areas,
        "fields": ["occ", "area", *VALUE_COLS],
        "rows": compact_rows,
    }
    path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    # Also a pretty copy for inspection.
    pretty = path.with_name(path.stem + ".pretty.json")
    pretty.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def coverage_report(rows: list[dict[str, Any]], areas: dict[str, Any]) -> dict[str, Any]:
    by_occ: dict[str, dict[str, int]] = {}
    suppressed = 0
    for rec in rows:
        bucket = by_occ.setdefault(rec["occ_code"], {"national": 0, "state": 0, "metro": 0, "rows": 0})
        bucket[rec["area_type"]] += 1
        bucket["rows"] += 1
        if rec["annual_median"] is None or rec["hourly_median"] is None:
            suppressed += 1
    ui_states = [
        a["name"]
        for a in areas.values()
        if a["type"] == "state" and a.get("in_ui")
    ]
    return {
        "total_rows": len(rows),
        "areas": {
            "national": sum(1 for a in areas.values() if a["type"] == "national"),
            "state_in_files": sum(1 for a in areas.values() if a["type"] == "state"),
            "state_in_ui": len(ui_states),
            "metro": sum(1 for a in areas.values() if a["type"] == "metro"),
        },
        "by_occupation": by_occ,
        "rows_missing_median": suppressed,
    }


def find_cached(cache_dir: Path, year: int) -> dict[str, Path] | None:
    yy = str(year)[2:]
    # Accept either the zip or the already-extracted xlsx.
    mapping = {
        "nat": list(cache_dir.rglob(f"national_M{year}_dl.xlsx"))
        or list(cache_dir.rglob(f"oesm{yy}nat.zip")),
        "st": list(cache_dir.rglob(f"state_M{year}_dl.xlsx"))
        or list(cache_dir.rglob(f"oesm{yy}st.zip")),
        "ma": list(cache_dir.rglob(f"MSA_M{year}_dl.xlsx"))
        or list(cache_dir.rglob(f"oesm{yy}ma.zip")),
    }
    if all(mapping[k] for k in mapping):
        return {k: mapping[k][0] for k in mapping}
    return None


def materialize(source: Path, kind: str, year: int, work: Path) -> Path:
    if source.suffix.lower() == ".xlsx":
        return source
    needle = {"nat": f"national_M{year}_dl", "st": f"state_M{year}_dl", "ma": "MSA_M"}[kind]
    if kind == "ma":
        needle = "MSA_M"
    copied = work / source.name
    if source.resolve() != copied.resolve():
        copied.write_bytes(source.read_bytes())
    return extract_xlsx(copied, needle)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=DEFAULT_YEAR, help="OEWS vintage year (May YYYY)")
    parser.add_argument(
        "--from-cache",
        type=Path,
        default=None,
        help="Directory already holding oesmYYnat/st/ma zips or the extracted xlsx files",
    )
    parser.add_argument("--out", type=Path, default=DATA_DIR, help="Output directory")
    args = parser.parse_args()

    year = args.year
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    yy = str(year)[2:]

    with tempfile.TemporaryDirectory(prefix="oews_") as tmp:
        work = Path(tmp)
        if args.from_cache:
            cached = find_cached(args.from_cache, year)
            if not cached:
                sys.exit(f"Could not find May {year} nat/st/MSA files under {args.from_cache}")
            nat_x = materialize(cached["nat"], "nat", year, work)
            st_x = materialize(cached["st"], "st", year, work)
            ma_x = materialize(cached["ma"], "ma", year, work)
            retrieved_via = f"local cache {args.from_cache.resolve()}"
        else:
            urls = {
                "nat": f"{SPECIAL_REQUESTS}/oesm{yy}nat.zip",
                "st": f"{SPECIAL_REQUESTS}/oesm{yy}st.zip",
                "ma": f"{SPECIAL_REQUESTS}/oesm{yy}ma.zip",
            }
            zips = {k: download(url, work / Path(url).name) for k, url in urls.items()}
            nat_x = extract_xlsx(zips["nat"], f"national_M{year}_dl")
            st_x = extract_xlsx(zips["st"], f"state_M{year}_dl")
            ma_x = extract_xlsx(zips["ma"], "MSA_M")
            retrieved_via = f"{SPECIAL_REQUESTS}/oesm{yy}{{nat,st,ma}}.zip"

        needed = ["AREA", "AREA_TITLE", "AREA_TYPE", "PRIM_STATE", "NAICS", "OCC_CODE", "OCC_TITLE", "O_GROUP", *BLS_COLS]
        nat = load_workbook(nat_x, needed)
        st = load_workbook(st_x, needed)
        msa = load_workbook(ma_x, needed)

        rows = collect(nat, st, msa)
        if not rows:
            sys.exit("No rows extracted. Check OCC codes and workbook layout.")
        # Stable sort: occupation order, then national, state name, metro name.
        occ_rank = {c: i for i, c in enumerate(OCC_ORDER)}
        type_rank = {"national": 0, "state": 1, "metro": 2}
        rows.sort(key=lambda r: (occ_rank[r["occ_code"]], type_rank[r["area_type"]], r["area_title"], r["area_id"]))
        areas = build_areas(rows)

        today = dt.date.today().isoformat()
        meta = {
            "program": "Occupational Employment and Wage Statistics (OEWS)",
            "publisher": "U.S. Bureau of Labor Statistics",
            "citation": CITATION.format(year=year),
            "reference_period": f"May {year}",
            "release_year": year,
            "source_page": SOURCE_PAGE,
            "source_files": [
                f"{SPECIAL_REQUESTS}/oesm{yy}nat.zip",
                f"{SPECIAL_REQUESTS}/oesm{yy}st.zip",
                f"{SPECIAL_REQUESTS}/oesm{yy}ma.zip",
            ],
            "technical_notes": TECHNICAL_NOTES,
            "retrieved": today,
            "retrieved_via": retrieved_via,
            "suppressed_flags": "Values published as *, **, # or ~ are stored as null and should be shown as n/a. They are not zeros.",
            "notes": [
                "Figures are payroll estimates and exclude the self-employed.",
                "Percentiles are wage distributions, not experience levels.",
                "Metro areas are metropolitan statistical areas (AREA_TYPE 4). Nonmetro / balance-of-state areas are omitted.",
                "State dropdown includes the 50 states, the District of Columbia, and Puerto Rico. Guam and the U.S. Virgin Islands are in the data files only.",
            ],
        }
        report = coverage_report(rows, areas)
        meta["coverage"] = report

        csv_path = out / f"oews_may{year}.csv"
        json_path = out / f"oews_may{year}.json"
        write_csv(csv_path, rows)
        write_json(json_path, rows, areas, meta)
        (out / "coverage.json").write_text(json.dumps({"meta": meta, "coverage": report}, indent=2), encoding="utf-8")
        # Pointer used by the widget when the year changes.
        (out / "current.json").write_text(
            json.dumps({"year": year, "file": json_path.name, "citation": meta["citation"]}, indent=2)
            + "\n",
            encoding="utf-8",
        )

    print("Wrote", csv_path, f"({csv_path.stat().st_size:,} bytes)")
    print("Wrote", json_path, f"({json_path.stat().st_size:,} bytes)")
    print("Coverage:", json.dumps(report, indent=2))
    print("Next: python3 scripts/refresh_job_counts.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
