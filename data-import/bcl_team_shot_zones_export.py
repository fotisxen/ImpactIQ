"""
Pulls REAL per-zone shooting data (makes/attempts, not just percentages) for
every Basketball Champions League team from 3stepsbasket.com's team shot
chart page — same source and technique as esake_team_shot_zones_export.py
(see that file's docstring for the full discovery notes: 11 fixed SVG zone
circles, hover-revealed "(makes/attempts)" tooltip already present in the
DOM, no reverse-engineered API needed).

Team slugs below were read directly off https://3stepsbasket.com/bcl/standings
and mapped to this app's own (now-deduplicated — see the BCL team-merge done
in this same session, which collapsed 52 rows down to the real 32 clubs)
`teams` table names under "Basketball Champions League".

Setup:
    pip install playwright
    python -m playwright install chromium   (skip if already installed)

Usage:
    python bcl_team_shot_zones_export.py --out ./out-bcl-shot-zones
"""

import argparse
import csv
import os
import re
import time

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

# slug -> the exact team name in this app's `teams` table (Basketball Champions League).
TEAM_SLUGS = {
    "lietuvos-rytas": "Rytas",
    "aek": "AEK",
    "unicaja-malaga": "Unicaja",
    "iberostar-tenerife": "La Laguna Tenerife",
    "cez-nymburk": "ERA Nymburk",
    "joventut-badalona": "Joventut Badalona",
    "galatasaray": "Galatasaray",
    "alba-berlin": "Alba Berlin",
    "le-mans": "Le Mans",
    "hapoel-holon": "Hapoel Netanel Holon",
    "tofas-bursa": "Tofaş",
    "karditsa": "Karditsa",
    "wurzburg": "Würzburg Baskets",
    "elan-chalon": "Élan Chalon",
    "gran-canaria": "Dreamland Gran Canaria",
    "trieste": "Pallacanestro Trieste",
    "heidelberg": "MLP Academics Heidelberg",
    "promitheas-patras": "Promitheas Patras",
    "trapani": "Trapani Shark",
    "cholet": "Cholet",
    "patrioti-levice": "Patrioti Levice",
    "szolnok-olaj": "NHSZ-Szolnoki",
    "mersin-msk": "Mersin",
    "spartak-subotica": "Spartak",
    "legia-warsaw": "Legia Warszawa",
    "sabah": "Sabah",
    "bursaspor-basketbol": "Bursaspor",
    "bnei-herzliya": "Bnei Herzliya",
    "kk-igokea": "Igokea",
    "vef-riga": "VEF Rīga",
    "telenet-oostende": "Filou Oostende",
    "benfica": "Benfica",
}

SEASON_SLUG = "bcl26"

# Fixed (cx, cy) template, confirmed identical across every team/player shot
# chart page on this site -> our 5-zone bucket.
ZONE_TEMPLATE = [
    ("269", "84", "at_rim"),
    ("269", "224", "mid_range"),
    ("164", "44", "mid_range"),
    ("114", "124", "mid_range"),
    ("374", "44", "mid_range"),
    ("424", "124", "mid_range"),
    ("269", "304", "top_key_3"),
    ("94", "234", "wing_3"),
    ("444", "234", "wing_3"),
    ("34", "64", "corner_3"),
    ("504", "64", "corner_3"),
]

TOOLTIP_RE = re.compile(r"\(\s*(\d+)\s*/\s*(\d+)\s*\)")


def log(msg: str) -> None:
    print(f"[bcl-shot-zones] {msg}", flush=True)


def accept_cookies(page) -> None:
    try:
        page.get_by_role("button", name="Accept", exact=True).first.click(timeout=4000)
    except PlaywrightTimeoutError:
        pass


def new_page(browser):
    return browser.new_page(viewport={"width": 1280, "height": 1400}, user_agent=USER_AGENT)


def scrape_shot_chart_once(page, url: str) -> dict[str, tuple[int, int]] | None:
    page.goto(url, timeout=45000, wait_until="domcontentloaded")
    try:
        page.wait_for_selector("svg circle[cx='269'][cy='84']", timeout=15000)
    except PlaywrightTimeoutError:
        return None
    page.wait_for_timeout(600)

    totals = {"at_rim": [0, 0], "mid_range": [0, 0], "top_key_3": [0, 0], "wing_3": [0, 0], "corner_3": [0, 0]}
    zones_resolved = 0
    for cx, cy, zone in ZONE_TEMPLATE:
        circle = page.locator(f"svg circle[cx='{cx}'][cy='{cy}']").first
        m = None
        for attempt in range(4):
            try:
                circle.scroll_into_view_if_needed(timeout=3000)
                circle.hover(timeout=5000, force=True)
            except PlaywrightError:
                page.wait_for_timeout(250)
                continue
            page.wait_for_timeout(250)
            tooltip_text = ""
            try:
                tooltip_text = page.locator("div.tooltip").first.inner_text(timeout=2000)
            except PlaywrightError:
                pass
            m = TOOLTIP_RE.search(tooltip_text)
            if m:
                break
            page.wait_for_timeout(250)
        if not m:
            log(f"    zone ({cx},{cy}) [{zone}]: tooltip never resolved after 4 attempts, skipping this zone.")
            continue
        fgm, fga = int(m.group(1)), int(m.group(2))
        totals[zone][0] += fgm
        totals[zone][1] += fga
        zones_resolved += 1

    total_fga = sum(v[1] for v in totals.values())
    # A real BCL team cannot genuinely have zero attempts in a broad zone
    # across a whole season, let alone all 5 — that pattern (confirmed live,
    # a full run in this exact session) means the page was in a bad state
    # (stale/degraded renderer after many navigations) and every hover
    # resolved to a leftover/blank "(0/0)" tooltip instead of real data, not
    # that the team is genuinely 0-for-everything. Treat it as a failed
    # scrape, not a real result, so the caller retries with a fresh page.
    if zones_resolved == 0 or total_fga == 0:
        return None
    return {z: (v[0], v[1]) for z, v in totals.items()}


def scrape_shot_chart(browser, url: str, page) -> tuple[dict[str, tuple[int, int]] | None, "object"]:
    """Wraps scrape_shot_chart_once with one retry on a completely fresh page
    if the result looks like a stale/degraded-renderer failure (see the
    all-zero check above) — returns (result, page) since a retry may swap in
    a new page object the caller should keep using."""
    result = scrape_shot_chart_once(page, url)
    if result is not None:
        return result, page
    log("    result looked invalid (all-zero) — retrying once with a fresh page...")
    try:
        page.close()
    except PlaywrightError:
        pass
    page = new_page(browser)
    result = scrape_shot_chart_once(page, url)
    return result, page


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=str, default="./out-bcl-shot-zones", help="Output folder for the CSV")
    ap.add_argument("--teams", type=str, default=None, help="Comma-separated slugs to restrict to (default: all 32)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    slugs = args.teams.split(",") if args.teams else list(TEAM_SLUGS.keys())
    out_path = os.path.join(args.out, "team_shot_zones.csv")
    fieldnames = ["team_name", "zone", "fgm", "fga"]

    already_done = set()
    if os.path.exists(out_path):
        with open(out_path, encoding="utf-8") as f:
            already_done = {row["team_name"] for row in csv.DictReader(f)}
        if already_done:
            log(f"Resuming: {len(already_done)} team(s) already in {out_path}, will be skipped.")

    is_new = not os.path.exists(out_path)
    out_f = open(out_path, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(out_f, fieldnames=fieldnames)
    if is_new:
        writer.writeheader()

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        page = new_page(browser)
        page.goto("https://3stepsbasket.com/", timeout=45000, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        accept_cookies(page)
        page.wait_for_timeout(500)

        scraped_count = 0
        for slug in slugs:
            team_name = TEAM_SLUGS.get(slug, slug)
            if team_name in already_done:
                continue

            # Preventive page recycling — a long-lived tab across many real
            # navigations degrades (confirmed live this session: a run of
            # ~11 consecutive teams came back all-zero mid-run), same class
            # of issue as the BCL/FIBA box-score scrapers' own
            # PAGE_RECYCLE_EVERY fix.
            if scraped_count > 0 and scraped_count % 6 == 0:
                log("  recycling the browser page (preventive)...")
                try:
                    page.close()
                except PlaywrightError:
                    pass
                page = new_page(browser)

            url = f"https://3stepsbasket.com/club/{slug}/stats?season={SEASON_SLUG}"
            log(f"Scraping {team_name} ({url})...")
            try:
                zones, page = scrape_shot_chart(browser, url, page)
            except PlaywrightError as exc:
                log(f"  page error for {team_name} ({exc}) — reopening page and skipping this team for now.")
                try:
                    page.close()
                except PlaywrightError:
                    pass
                page = new_page(browser)
                continue

            if not zones:
                log(f"  no valid chart data for {team_name} after retry — skipping (will need a manual re-run).")
                continue
            scraped_count += 1

            for zone, (fgm, fga) in zones.items():
                writer.writerow({"team_name": team_name, "zone": zone, "fgm": fgm, "fga": fga})
            out_f.flush()
            total_fga = sum(v[1] for v in zones.values())
            log(f"  {team_name}: {total_fga} total FGA across 5 zones.")
            time.sleep(0.5)

        browser.close()

    out_f.close()
    log(f"Done. Wrote {out_path}")


if __name__ == "__main__":
    main()
