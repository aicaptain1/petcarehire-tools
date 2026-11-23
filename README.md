# petcarehire-tools

Static files for the Pet Care Hire salary calculator. The live site loads two files from jsDelivr, pinned to a release tag:

- https://cdn.jsdelivr.net/gh/aicaptain1/petcarehire-tools@v1.0.0/dist/widget.js
- https://cdn.jsdelivr.net/gh/aicaptain1/petcarehire-tools@v1.0.0/dist/salary_tool_payload.json

`widget.js` does not hardcode a data URL. The loader in `docs/loader_snippet.html` sets `data-src` on `#pch-salary-tool` and checks the payload with the sha384 value in `docs/INTEGRITY.txt`. Paste that snippet into Job Boardly Custom code. It runs only on `/blog/pet-care-salary-calculator`. Keep the pin on a tag such as `@v1.0.0`, not `@main`.

## Layout

| Path | Role |
| --- | --- |
| `dist/widget.js` | Calculator script the site loads |
| `dist/salary_tool_payload.json` | Wage rows plus job counts the site loads |
| `data/oews_may2025.csv` | Cleaned OEWS extract for May 2025 |
| `data/job_counts_2026-11-23.json` | Job-count snapshot taken 2026-11-23 |
| `scripts/refresh_data.py` | Rebuild the OEWS CSV and JSON from BLS |
| `scripts/refresh_job_counts.py` | Snapshot live job counts and rebuild `dist/salary_tool_payload.json` |
| `preview/salary_tool.html` | Self-contained local preview (inlines the data; does not use the CDN) |
| `docs/loader_snippet.html` | Site loader, pinned to `@v1.0.0` with SRI hashes |
| `docs/INTEGRITY.txt` | sha384 hashes for the two `dist/` files |
| `docs/TRACKING.md` | How jobs-button clicks are tagged |

## Data source

Wages are from the U.S. Bureau of Labor Statistics, Occupational Employment and Wage Statistics (OEWS), May 2025. The bulk files are the national, state, and metropolitan workbooks linked from [bls.gov/oes/tables.htm](https://www.bls.gov/oes/tables.htm). The calculator uses five occupations: veterinary technologists and technicians (29-2056), veterinary assistants and laboratory animal caretakers (31-9096), veterinarians (29-1131), animal caretakers (39-2021), and receptionists and information clerks (43-4171).

BLS suppression and cap flags (`*`, `**`, `#`, `~`) are stored as null and shown as n/a. They are not zeros. Figures are payroll estimates and exclude the self-employed. Job counts are a separate snapshot of public listings on petcarehire.com, not a BLS statistic.

## Refresh yearly

BLS publishes a new OEWS release each spring for the previous May. From the repository root, with `pandas` and `openpyxl` installed:

```bash
python3 scripts/refresh_data.py --year 2026
python3 scripts/refresh_job_counts.py
```

`refresh_data.py` downloads the official OEWS zips (it sends an identifying User-Agent; BLS rejects anonymous clients) and writes `data/oews_mayYYYY.csv` plus `data/oews_mayYYYY.json`. Pass `--from-cache DIR` if those workbooks are already on disk.

`refresh_job_counts.py` reads public petcarehire.com listing pages, writes `data/job_counts_YYYY-MM-DD.json`, and merges the newest `data/oews_mayYYYY.json` into `dist/salary_tool_payload.json`. Neither script invents wage numbers.

After `dist/widget.js` or `dist/salary_tool_payload.json` changes:

1. Recompute sha384 (standard base64) of those two files.
2. Put the new `sha384-...` values in `docs/INTEGRITY.txt` and `docs/loader_snippet.html`.
3. Commit, tag a new release (the next tag after `v1.0.0`), and point the loader at that tag.

```bash
python3 -c "import hashlib,base64,pathlib; p=pathlib.Path('dist/widget.js'); print('sha384-'+base64.b64encode(hashlib.sha384(p.read_bytes()).digest()).decode())"
```

The hash has to describe the file bytes at the tag. If a docs edit would change a `dist/` file, move that edit to a later commit or retag so the tag and the hashes still match.
