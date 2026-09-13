"""
Pulls the Greek Cup (Kypello Elladas) games that actually involve this app's
13 seeded top-tier clubs, from stats.basket.gr — the Hellenic Basketball
Federation's own official stats platform (a different site/vendor than
esake.gr, which has no Cup coverage of its own at all; confirmed by direct
inspection of esake.gr's own site nav, which only lists Basket League
seasons, no Cup section).

The Greek Cup runs ~80 teams through several early qualifying phases before
narrowing to the top-tier clubs — those early phases (2nd Phase, UNICEF
Trophy) are entirely lower-division/amateur clubs not in this app's scope
(confirmed by checking every team logo shown on those phase pages — none
match our 13 seeded club IDs). Our 13 clubs first appear in:
  - "4th Phase" (games-fourth): single-elimination round, some clubs get a
    bye straight to Final-8 (the higher seeds), others (mid-table clubs)
    play one game here to earn their Final-8 spot.
  - "Final-8" (games-final8): QF (4 games) -> SF (2 games) -> Final (1 game).

Each game has a real, stable URL:
    https://stats.basket.gr/2025-2026/cup-men/gamedetails/id/{GUID}
whose "BOX SCORE" tab renders a real per-player stat table in plain page
text (same discipline as this project's other scrapers — no fabricated or
estimated numbers, only what the site actually shows).

Team-name detection: rather than trying to associate each box-score <table>
with a team name via fragile DOM-position heuristics (the page is a
DotNetNuke site with 80+ unrelated <table>s per page, mostly sidebar
widgets), the home/away team names are read directly off the LISTING page
(where they're unambiguous plain text) and passed through — the game detail
page's own two box-score tables are then just taken in visual order (home
team's table first, matching every game checked by hand).

Setup:
    pip install playwright
    python -m playwright install chromium   (skip if already installed)

Usage:
    python greek_cup_season_export.py --out ./out-greek-cup
"""

import argparse
import csv
import os
import re
import time

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
BASE = "https://stats.basket.gr/2025-2026/cup-men"
PHASE_LISTING_PAGES = {
    "4th Phase": f"{BASE}/games-fourth",
    "Final-8": f"{BASE}/games-final8",
}

# stats.basket.gr's own team names -> the exact team name already seeded in
# this app's `teams` table under "Greek Cup" (mirrors the Greek Basket League
# roster, per seed.js's own design). Games whose BOTH teams aren't in this
# map are skipped (a lower-tier opponent that isn't one of our 13 clubs).
GREEK_TO_APP_NAME = {
    "ΑΕΚ": "AEK",
    "ΑΕΚ BC": "AEK",
    "ΑΡΗΣ BETSSON": "Aris",
    "ΗΡΑΚΛΗΣ ΚΑΕ": "Iraklis",
    "ΚΑΡΔΙΤΣΑ ΙΑΠΩΝΙΚΗ": "Karditsa",
    "ΚΟΛΟΣΣΟΣ H HOTELS COLLECTION": "Kolossos Rodou",
    "ΜΑΡΟΥΣΙ CHERY": "Maroussi",
    "ΜΥΚΟΝΟΣ BETSSON BC": "Mykonos",
    "ΟΛΥΜΠΙΑΚΟΣ": "Olympiacos",
    # Stats.basket.gr spells Panathinaikos two different ways across pages —
    # with the diaeresis (ΠΑΝΑΘΗΝΑΪΚΟΣ, Ϊ = U+03AA) on some, without it
    # (ΠΑΝΑΘΗΝΑΙΚΟΣ, Ι = U+0399) on others, and "Aktor" isn't always
    # capitalized — both confirmed by direct inspection of real game titles.
    "ΠΑΝΑΘΗΝΑΪΚΟΣ AKTOR": "Panathinaikos",
    "ΠΑΝΑΘΗΝΑΙΚΟΣ AKTOR": "Panathinaikos",
    "ΠΑΝΙΩΝΙΟΣ": "Panionios",
    "ΠΑΟΚ": "PAOK",
    "ΑΣ ΠΑΟΚ": "PAOK",
    "ΠΕΡΙΣΤΕΡΙ BETSSON": "Peristeri",
    "ΠΡΟΜΗΘΕΑΣ ΒΙΚΟΣ COLA": "Promitheas Patras",
}

MONTHS_GR = {
    "Ιανουαρίου": 1, "Φεβρουαρίου": 2, "Μαρτίου": 3, "Απριλίου": 4, "Μαΐου": 5, "Ιουνίου": 6,
    "Ιουλίου": 7, "Αυγούστου": 8, "Σεπτεμβρίου": 9, "Οκτωβρίου": 10, "Νοεμβρίου": 11, "Δεκεμβρίου": 12,
}
DATE_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")


def log(msg: str) -> None:
    print(f"[greek-cup] {msg}", flush=True)


def new_page(browser):
    return browser.new_page(viewport={"width": 1400, "height": 1200}, user_agent=USER_AGENT)


def collect_game_ids(page, listing_url: str) -> list[str]:
    page.goto(listing_url, timeout=45000, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    hrefs = page.eval_on_selector_all(
        "a[href*='gamedetails/id/']",
        "els => [...new Set(els.map(e => e.getAttribute('href')))]",
    )
    ids = []
    for h in hrefs:
        m = re.search(r"gamedetails/id/([0-9A-Fa-f-]{36})", h)
        if m and m.group(1) not in ids:
            ids.append(m.group(1))
    return ids


TITLE_RE = re.compile(r"^(.+?)\s+-\s+(.+?)\s+/", re.UNICODE)
LONGDATE_RE = re.compile(
    r"(\d{1,2})\s+(" + "|".join(re.escape(m) for m in MONTHS_GR) + r")\s+(\d{4})"
)


def parse_teams_from_title(title: str) -> tuple[str | None, str | None]:
    """The page's own <title> is "{HOME} - {AWAY} / {phase label}" — far more
    reliable than any DOM-position heuristic on a page with 80+ unrelated
    <table> widgets (confirmed by direct inspection of a real game page)."""
    m = TITLE_RE.match(title.strip())
    if not m:
        return None, None
    return m.group(1).strip(), m.group(2).strip()


def parse_date_from_body(body_text: str) -> str | None:
    m = LONGDATE_RE.search(body_text)
    if not m:
        return None
    day, month_name, year = m.groups()
    return f"{year}-{MONTHS_GR[month_name]:02d}-{int(day):02d}"


def parse_fraction(cell_text: str) -> tuple[int, int]:
    m = re.search(r"(\d+)\s*/\s*(\d+)", cell_text)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def parse_boxscore_tables(page) -> list[list[dict]] | None:
    """Clicks the Box score tab, then finds every <table> whose text
    contains both "Players" and "TOTALS" (the real per-team box score
    tables — every other <table> on this DotNetNuke-heavy page is an
    unrelated widget) and parses its player rows, in DOM order (which
    matches home-team-first / away-team-second on every game checked)."""
    try:
        page.get_by_role("link", name="Box score", exact=False).first.click(timeout=8000, force=True)
    except PlaywrightError:
        pass
    page.wait_for_timeout(1000)
    try:
        page.wait_for_selector("text=TOTALS", timeout=10000)
    except PlaywrightTimeoutError:
        return None

    candidate_tables = page.locator("table").filter(has_text="TOTALS").filter(has_text="Players")
    count = candidate_tables.count()
    if count < 2:
        return None

    result = []
    for i in range(min(count, 2)):
        table = candidate_tables.nth(i)
        cell_rows = table.evaluate(
            "el => [...el.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td,th')].map(td => td.innerText.trim()))"
        )
        # Real column layout, confirmed by direct inspection of a live table's
        # cells (NOT assumed from the visible header labels alone — the "ST"
        # starter-marker column sits between Players and MIN, shifting every
        # later column right by one):
        #   0=#, 1=Players, 2=ST, 3=MIN, 4=PTS, 5=FT, 6=2PTS, 7=3PTS, 8=FG,
        #   9=OREB, 10=DREB, 11=REB, 12=AST, 13=STL, 14=BLK, 15=TO, 16=PF, 17=FO, 18=EF
        rows_out = []
        for cells in cell_rows:
            if len(cells) < 19:
                continue
            name = cells[1]
            if not name or name.upper() in ("PLAYERS", "TEAM/COACHES", "TOTALS"):
                continue
            ftm, fta = parse_fraction(cells[5])
            twom, twoa = parse_fraction(cells[6])
            threem, threea = parse_fraction(cells[7])
            fgm, fga = parse_fraction(cells[8])
            rows_out.append({
                "name": name, "min": cells[3], "pts": cells[4],
                "ftm": ftm, "fta": fta, "twom": twom, "twoa": twoa,
                "threem": threem, "threea": threea, "fgm": fgm, "fga": fga,
                "oreb": cells[9], "dreb": cells[10], "reb": cells[11],
                "ast": cells[12], "stl": cells[13], "blk": cells[14],
                "to": cells[15], "pf": cells[16],
            })
        result.append(rows_out)
    return result if all(result) else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=str, default="./out-greek-cup", help="Output folder for CSVs")
    ap.add_argument("--phases", type=str, default=None,
                     help=f"Comma-separated phases to scrape. Default: all of {list(PHASE_LISTING_PAGES)}.")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    phases = args.phases.split(",") if args.phases else list(PHASE_LISTING_PAGES)

    games_path = os.path.join(args.out, "games.csv")
    rows_path = os.path.join(args.out, "player_boxscores.csv")
    already_done = set()
    if os.path.exists(games_path):
        with open(games_path, encoding="utf-8") as f:
            already_done = {row["idgame"] for row in csv.DictReader(f)}
        if already_done:
            log(f"Resuming: {len(already_done)} game(s) already done, will be skipped.")

    games_is_new = not os.path.exists(games_path)
    rows_is_new = not os.path.exists(rows_path)
    games_f = open(games_path, "a", newline="", encoding="utf-8")
    rows_f = open(rows_path, "a", newline="", encoding="utf-8")
    games_w = csv.DictWriter(games_f, fieldnames=["idgame", "phase", "date", "home_team", "away_team", "home_score", "away_score"])
    rows_w = csv.DictWriter(rows_f, fieldnames=["idgame", "team", "name", "min", "pts", "ftm", "fta",
                                                  "twom", "twoa", "threem", "threea", "fgm", "fga",
                                                  "oreb", "dreb", "reb", "ast", "stl", "blk", "to", "pf"])
    if games_is_new:
        games_w.writeheader()
    if rows_is_new:
        rows_w.writeheader()

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        page = new_page(browser)

        all_game_ids: list[tuple[str, str]] = []
        for phase in phases:
            listing_url = PHASE_LISTING_PAGES[phase]
            log(f"Listing games for {phase} ({listing_url})...")
            ids = collect_game_ids(page, listing_url)
            log(f"  found {len(ids)} game(s).")
            for gid in ids:
                all_game_ids.append((phase, gid))

        scraped = 0
        skipped_other_teams = 0
        for phase, game_id in all_game_ids:
            if game_id in already_done:
                continue

            url = f"{BASE}/gamedetails/id/{game_id}"
            log(f"Scraping {phase} game {game_id}...")
            try:
                page.goto(url, timeout=45000, wait_until="domcontentloaded")
                page.wait_for_timeout(800)
                home_raw, away_raw = parse_teams_from_title(page.title())
                date_iso = parse_date_from_body(page.inner_text("body"))
                tables = parse_boxscore_tables(page)
            except PlaywrightError as exc:
                log(f"  page error ({exc}) — reopening page, skipping this game for now.")
                try:
                    page.close()
                except PlaywrightError:
                    pass
                page = new_page(browser)
                continue

            if not home_raw or not away_raw:
                log("  could not parse team names from page title, skipping.")
                continue
            home_app = GREEK_TO_APP_NAME.get(home_raw.upper())
            away_app = GREEK_TO_APP_NAME.get(away_raw.upper())
            if not home_app or not away_app:
                skipped_other_teams += 1
                log(f"  {phase} {home_raw} vs {away_raw}: not both teams in our 13-club scope, skipping.")
                continue

            if not tables:
                log(f"  {home_app} vs {away_app}: no box score tables found, skipping.")
                continue

            home_rows, away_rows = tables[0], tables[1]
            home_score = sum(int(r["pts"] or 0) for r in home_rows)
            away_score = sum(int(r["pts"] or 0) for r in away_rows)
            games_w.writerow({
                "idgame": game_id, "phase": phase, "date": date_iso or "",
                "home_team": home_app, "away_team": away_app,
                "home_score": home_score, "away_score": away_score,
            })
            for r in home_rows:
                r2 = dict(r); r2["idgame"] = game_id; r2["team"] = home_app
                rows_w.writerow(r2)
            for r in away_rows:
                r2 = dict(r); r2["idgame"] = game_id; r2["team"] = away_app
                rows_w.writerow(r2)
            games_f.flush()
            rows_f.flush()
            scraped += 1
            log(f"  {home_app} {home_score} - {away_score} {away_app}")
            time.sleep(0.5)

        browser.close()

    games_f.close()
    rows_f.close()
    log(f"\nDone. Scraped {scraped} games ({skipped_other_teams} skipped — not both teams in our 13-club scope).")


if __name__ == "__main__":
    main()
