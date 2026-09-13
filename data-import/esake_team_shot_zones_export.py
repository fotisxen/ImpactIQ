"""
Pulls REAL per-zone shooting data (makes/attempts, not just percentages) for
every Greek Basket League (ESAKE) team from 3stepsbasket.com's team shot
chart page — the source discovered by hand-inspecting
https://3stepsbasket.com/club/{slug}/stats?season=gbl26, confirmed to be a
genuine third-party analytics site (not affiliated with esake.gr, which has
no shot-location data of its own) built on real box-score/play-by-play data.

The page renders an SVG shot chart with 11 FIXED zone circles (same (cx,cy)
template on every team/player page, confirmed by direct inspection) showing
only a percentage by default — the real makes/attempts (e.g. "59.0%
(85/144)") only appears in a tooltip on hover/tap. That tooltip text is
already present in the DOM once the hover fires (confirmed: no extra network
request happens), so Playwright's normal `.hover()` + reading the tooltip
element is enough — no reverse-engineered API needed.

The 11 template zones collapse cleanly onto this app's existing 5-zone
shot_zones schema (at_rim / mid_range / corner_3 / wing_3 / top_key_3) by
position:
    (269, 84)                                -> at_rim (restricted area)
    (269,224) (164,44) (114,124) (374,44) (424,124) -> mid_range (5 zones, summed)
    (269,304)                                -> top_key_3
    (94,234)  (444,234)                      -> wing_3 (2 zones, summed)
    (34,64)   (504,64)                       -> corner_3 (2 zones, summed)

Team slugs (confirmed against the real ESAKE standings page) map 1:1 to the
team names already seeded under "Greek Basket League" in seed.js:
    aek, aris, iralkis, karditsa, rodos, maroussi, mykonos, olympiacos,
    panathinaikos, panionios, paok, promitheas-patras, peristeri

Setup:
    pip install playwright
    python -m playwright install chromium   (skip if already installed)

Usage:
    python esake_team_shot_zones_export.py --out ./out-esake-shot-zones
"""

import argparse
import csv
import os
import re
import time

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

# slug -> the exact team name already used in this app's `teams` table (Greek Basket League).
TEAM_SLUGS = {
    "olympiacos": "Olympiacos",
    "panathinaikos": "Panathinaikos",
    "paok": "PAOK",
    "aek": "AEK",
    "aris": "Aris",
    "peristeri": "Peristeri",
    "mykonos": "Mykonos",
    "rodos": "Kolossos Rodou",
    "iralkis": "Iraklis",
    "promitheas-patras": "Promitheas Patras",
    "karditsa": "Karditsa",
    "maroussi": "Maroussi",
    "panionios": "Panionios",
}

SEASON_SLUG = "gbl26"

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
    print(f"[esake-shot-zones] {msg}", flush=True)


def accept_cookies(page) -> None:
    try:
        page.get_by_role("button", name="Accept", exact=True).first.click(timeout=4000)
    except PlaywrightTimeoutError:
        pass


def new_page(browser):
    return browser.new_page(viewport={"width": 1280, "height": 1400}, user_agent=USER_AGENT)


def scrape_shot_chart(page, url: str) -> dict[str, tuple[int, int]] | None:
    """Returns {zone: (fgm, fga)} summed across the 11 template circles, or
    None if the chart never rendered (e.g. a team/player with zero attempts
    this season)."""
    page.goto(url, timeout=45000, wait_until="domcontentloaded")
    try:
        page.wait_for_selector("svg circle[cx='269'][cy='84']", timeout=15000)
    except PlaywrightTimeoutError:
        return None
    page.wait_for_timeout(300)

    totals = {"at_rim": [0, 0], "mid_range": [0, 0], "top_key_3": [0, 0], "wing_3": [0, 0], "corner_3": [0, 0]}
    found_any = False
    for cx, cy, zone in ZONE_TEMPLATE:
        circle = page.locator(f"svg circle[cx='{cx}'][cy='{cy}']").first
        m = None
        for attempt in range(3):
            try:
                circle.hover(timeout=5000, force=True)
            except PlaywrightError:
                page.wait_for_timeout(200)
                continue
            page.wait_for_timeout(200)
            tooltip_text = ""
            try:
                tooltip_text = page.locator("div.tooltip").first.inner_text(timeout=2000)
            except PlaywrightError:
                pass
            m = TOOLTIP_RE.search(tooltip_text)
            if m:
                break
            page.wait_for_timeout(200)
        if not m:
            log(f"    zone ({cx},{cy}) [{zone}]: tooltip never resolved after 3 attempts, skipping this zone.")
            continue
        fgm, fga = int(m.group(1)), int(m.group(2))
        totals[zone][0] += fgm
        totals[zone][1] += fga
        found_any = True

    if not found_any:
        return None
    return {z: (v[0], v[1]) for z, v in totals.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=str, default="./out-esake-shot-zones", help="Output folder for the CSV")
    ap.add_argument("--teams", type=str, default=None, help="Comma-separated slugs to restrict to (default: all 13)")
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

        for slug in slugs:
            team_name = TEAM_SLUGS.get(slug, slug)
            if team_name in already_done:
                continue
            url = f"https://3stepsbasket.com/club/{slug}/stats?season={SEASON_SLUG}"
            log(f"Scraping {team_name} ({url})...")
            try:
                zones = scrape_shot_chart(page, url)
            except PlaywrightError as exc:
                log(f"  page error for {team_name} ({exc}) — reopening page and skipping this team for now.")
                try:
                    page.close()
                except PlaywrightError:
                    pass
                page = new_page(browser)
                continue

            if not zones:
                log(f"  no chart data found for {team_name} (0 attempts this season, or page layout changed) — skipping.")
                continue

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
