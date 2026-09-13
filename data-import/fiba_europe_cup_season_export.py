"""
Pulls a full FIBA Europe Cup season's box scores from fiba.basketball. Unlike
the EuroLeague/EuroCup and Greek Basket League scrapers, this one needs a
real browser (Playwright + headless Chromium) — the site's box score data is
only rendered client-side after JavaScript runs and a tab is clicked; it is
NOT present in the plain HTML response, and the site's bot-protection blocks
a default headless Chromium outright (confirmed empirically — the fix is the
`--disable-blink-features=AutomationControlled` launch flag plus a realistic
User-Agent, both already wired in below).

What this gets you, per game: real per-player box scores (points, FG/2PT/3PT/
FT with makes-attempts, rebounds off/def, assists, fouls, turnovers, steals,
blocks, +/-, and FIBA's own EFF rating — actually richer than EuroLeague's
own feed, e.g. real +/- per player). The site also has "Play by play" and
"Shot Chart" tabs that were not explored/scraped here — box scores alone are
the valuable, buildable win; extending to those would follow the same
click-tab-and-extract pattern if wanted later.

Setup:
    pip install playwright beautifulsoup4
    python -m playwright install chromium

Usage:
    python fiba_europe_cup_season_export.py --out ./out-fec
    python fiba_europe_cup_season_export.py --out ./out-fec --dates 2025Wed24SEP,2025Sat27SEP   (quick test)

This is much slower than the `requests`-based scrapers — each game needs a
real page load, a cookie-accept (once), a tab click, and a team-toggle click,
so budget several seconds per game. For ~150-180 games across the season,
expect this to take a while; the --dates flag lets you test on a handful of
matchdays first.

If Playwright's browser install fails or hangs, or you get "The request is
blocked" pages even with the flags below, the site's bot-protection may have
changed — this was verified working as of the date this script was written,
but automated-browser countermeasures are exactly the kind of thing sites
update over time.
"""

import argparse
import csv
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError

PAGE_RECYCLE_EVERY = 25  # close + reopen the page periodically — a long-lived tab across 100+ real
                          # page loads eventually crashes the renderer (confirmed empirically on the
                          # sibling BCL scraper: "Target crashed" partway through a 176-game run).


class PageCrashedError(Exception):
    """Raised when the page's renderer itself died — the page object is unusable
    after this, retrying on it is pointless; the caller must open a fresh one."""

BASE_URL = "https://www.fiba.basketball/en/events/fiba-europe-cup-25-26"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

STAT_HEADERS = [
    "MIN", "PTS", "FG", "2PT FG", "3PT FG", "FT", "OREB", "DREB", "REB",
    "AST", "PF", "TO", "STL", "BLK", "+/-", "EFF",
]


def log(msg: str) -> None:
    print(f"[fiba-ec] {msg}", flush=True)


def parse_made_attempted(s: str):
    m = re.match(r"^(\d+)\s*/\s*(\d+)", s.strip())
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def parse_boxscore_table_html(table_html: str, team_name: str) -> list[dict]:
    """
    Parses the table's real DOM cells (via BeautifulSoup on the table's
    inner_html()) rather than its flattened .inner_text() — cell boundaries
    are unambiguous this way, unlike text-splitting which desynchronizes on
    the first row that doesn't match the expected token count (confirmed
    empirically: real games have DNP rows, missing stats, and other row-shape
    variation that broke a naive text-based parser).

    A real played-minutes row has 18 cells:
      [#, "Name [* if starter] POS", MIN, PTS, FG "M/A (PCT%)", 2PT FG, 3PT FG,
       FT, OREB, DREB, REB, AST, PF, TO, STL, BLK, +/-, EFF]
    A DNP row has 4 cells: [#, Name, "Did Not Play", ""].
    The header row, "Team/Coaches", and "TOTAL" rows are skipped — no single
    player to credit team-level bench boxes to (same reasoning as every other
    scraper this session).
    """
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(table_html, "lxml")
    rows_out = []
    for tr in soup.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
        if not cells or cells[0] in ("#", "Team/Coaches", "TOTAL"):
            continue
        if not re.match(r"^\d+$", cells[0]):
            continue
        dorsal = cells[0]
        name_and_pos = cells[1]
        # "Margiris Normantas * SG" -> name "Margiris Normantas", drop the
        # trailing starter marker and position code.
        name = re.sub(r"\s*\*?\s*(PG|SG|SF|PF|C|G|F)?$", "", name_and_pos).rstrip("* ").strip()

        if len(cells) < 5 or cells[2] == "Did Not Play":
            rows_out.append({"team": team_name, "dorsal": dorsal, "name": name, "dnp": True})
            continue
        if len(cells) != 18:
            log(f"  unexpected cell count ({len(cells)}) for dorsal {dorsal} {name!r} — skipping this row.")
            continue

        try:
            minutes = cells[2]
            pts = int(cells[3])
            fgm, fga = parse_made_attempted(cells[4])
            tpm2, tpa2 = parse_made_attempted(cells[5])
            tpm3, tpa3 = parse_made_attempted(cells[6])
            ftm, fta = parse_made_attempted(cells[7])

            def as_int(v):
                return 0 if v in ("-", "") else int(v)

            oreb, dreb = as_int(cells[8]), as_int(cells[9])
            # cells[10] = REB total, redundant with oreb+dreb — skipped.
            ast, pf, tov, stl, blk = (as_int(cells[i]) for i in (11, 12, 13, 14, 15))
            plus_minus = 0 if cells[16] in ("-", "") else int(cells[16].replace("+", ""))
            eff = as_int(cells[17])
        except (ValueError, IndexError):
            log(f"  could not parse row for dorsal {dorsal} {name!r}: {cells} — skipping this row.")
            continue

        rows_out.append({
            "team": team_name, "dorsal": dorsal, "name": name, "dnp": False,
            "minutes_text": minutes, "pts": pts,
            "fgm": fgm, "fga": fga, "tpm2": tpm2, "tpa2": tpa2, "tpm3": tpm3, "tpa3": tpa3,
            "ftm": ftm, "fta": fta, "oreb": oreb, "dreb": dreb,
            "ast": ast, "pf": pf, "tov": tov, "stl": stl, "blk": blk,
            "plus_minus": plus_minus, "eff": eff,
        })
    return rows_out


def minutes_to_decimal(s: str) -> float:
    m = re.match(r"^(\d+):(\d+)$", s.strip())
    if not m:
        return 0.0
    mm, ss = int(m.group(1)), int(m.group(2))
    return mm + ss / 60


def new_boxscore_page(browser):
    return browser.new_page(viewport={"width": 1280, "height": 1000}, user_agent=USER_AGENT)


def accept_cookies(page) -> None:
    try:
        page.get_by_role("button", name="I accept", exact=True).first.click(timeout=4000)
    except PlaywrightTimeoutError:
        pass


MONTH_ABBR = {"SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12", "JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05"}


def date_label_to_iso(label: str) -> str | None:
    """'2025Wed24SEP' -> '2025-09-24' (year, weekday abbr, day, month abbr)."""
    m = re.match(r"^(\d{4})[A-Za-z]{3}(\d{2})([A-Z]{3})$", label)
    if not m:
        return None
    year, day, mon = m.groups()
    month = MONTH_ABBR.get(mon)
    return f"{year}-{month}-{day}" if month else None


def collect_game_urls(page, date_buttons: list[str]) -> dict[str, str]:
    """Returns {game_url: iso_date} — the matchday button's own label already
    encodes the real date, so no extra per-game page visit is needed for it."""
    url_to_date: dict[str, str] = {}
    for label in date_buttons:
        try:
            btn = page.locator("button").filter(has_text=re.compile(f"^{re.escape(label)}$")).first
            btn.click(timeout=8000)
            page.wait_for_timeout(1200)
        except PlaywrightTimeoutError:
            log(f"  could not click date button {label!r}, skipping.")
            continue
        links = page.eval_on_selector_all(
            "a", "els => els.map(e => e.href).filter(h => /\\/games\\//.test(h) && !h.endsWith('/games'))"
        )
        iso_date = date_label_to_iso(label)
        for u in links:
            url_to_date[u] = iso_date
        log(f"  {label}: {len(links)} game(s), running total {len(url_to_date)}")
    return url_to_date


def parse_quarter_scores(overview_text: str) -> dict | None:
    """From the default (Overview) tab's 'TEAM Q1 Q2 Q3 Q4' table — used only
    to cross-check the box score's summed points against a real final score,
    the same invariant check used for every other scraper this session."""
    lines = [l.strip() for l in overview_text.split("\n") if l.strip() != ""]
    try:
        idx = lines.index("Q4")
    except ValueError:
        return None
    # Two rows follow: TEAM_A_CODE, q1, q2, q3, q4, TEAM_B_CODE, q1, q2, q3, q4
    nums_start = idx + 1
    try:
        vals = lines[nums_start:nums_start + 10]
        code_a, q1a, q2a, q3a, q4a, code_b, q1b, q2b, q3b, q4b = vals
        return {
            "code_a": code_a, "score_a": sum(int(x) for x in (q1a, q2a, q3a, q4a)),
            "code_b": code_b, "score_b": sum(int(x) for x in (q1b, q2b, q3b, q4b)),
        }
    except (ValueError, IndexError):
        return None


def scrape_game(page, url: str) -> tuple[list[dict], dict] | None:
    for attempt in range(1, 4):
        try:
            page.goto(url, timeout=45000, wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
            accept_cookies(page)
            page.wait_for_timeout(500)

            overview_text = page.inner_text("main")
            quarter_scores = parse_quarter_scores(overview_text)

            page.get_by_role("button", name="Boxscore", exact=False).first.click(timeout=15000)
            page.wait_for_timeout(1200)

            headings = page.locator("h1, h2, h3, h4").all_text_contents()
            # The two team names appear as the first two headings on this tab
            # (confirmed by inspection); the second one doubles as the toggle
            # button's accessible name.
            team_a_name = headings[0].strip() if len(headings) > 0 else "Team A"
            team_b_name = headings[1].strip() if len(headings) > 1 else "Team B"

            team_a_html = page.locator("table").first.inner_html()
            rows = parse_boxscore_table_html(team_a_html, team_a_name)

            try:
                page.get_by_role("button", name=team_b_name, exact=True).first.click(timeout=8000)
                page.wait_for_timeout(1000)
                team_b_html = page.locator("table").first.inner_html()
                rows.extend(parse_boxscore_table_html(team_b_html, team_b_name))
            except PlaywrightTimeoutError:
                log(f"  could not toggle to team B ({team_b_name!r}) for {url} — only team A captured.")

            meta = {"team_a": team_a_name, "team_b": team_b_name, "quarter_scores": quarter_scores}
            return rows, meta
        except PlaywrightTimeoutError as exc:
            log(f"  attempt {attempt}/3 failed for {url}: {exc}")
            time.sleep(3)
        except PlaywrightError as exc:
            if "crashed" in str(exc).lower() or "closed" in str(exc).lower():
                raise PageCrashedError(str(exc)) from exc
            log(f"  attempt {attempt}/3 failed for {url}: {exc}")
            time.sleep(3)
    log(f"  giving up on {url} after 3 attempts.")
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=str, default="./out-fec", help="Output folder for CSVs")
    ap.add_argument("--dates", type=str, default=None,
                     help="Comma-separated matchday button labels to test with (e.g. 2025Wed24SEP,2025Sat27SEP). "
                          "Defaults to the full season's date list, discovered live from the page.")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        page = new_boxscore_page(browser)

        log("Loading the games schedule page...")
        page.goto(f"{BASE_URL}/games", timeout=60000, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        accept_cookies(page)
        page.wait_for_timeout(500)

        if args.dates:
            date_buttons = args.dates.split(",")
        else:
            all_buttons = page.locator("button").all_text_contents()
            date_buttons = [b.strip() for b in all_buttons if re.match(r"^\d{4}[A-Za-z]{3}\d{2}[A-Z]{3}$", b.strip())]
            log(f"Discovered {len(date_buttons)} matchday dates.")

        game_urls_dict = collect_game_urls(page, date_buttons)
        log(f"Total unique games found: {len(game_urls_dict)}")
        game_urls = sorted(game_urls_dict.keys())

        # Resume support: a game_id already present in games.csv from a
        # previous (interrupted) run is skipped rather than re-scraped —
        # this can be a long scrape (one real page load per game), so losing
        # everything to a Ctrl+C or a crash partway through is a real cost.
        games_path = os.path.join(args.out, "games.csv")
        rows_path = os.path.join(args.out, "player_boxscores.csv")
        games_fieldnames = ["game_id", "game_url", "date", "team_a", "team_b", "score_a", "score_b"]
        rows_fieldnames = ["game_id", "game_url", "team", "dorsal", "name", "dnp", "minutes_text", "pts",
                           "fgm", "fga", "tpm2", "tpa2", "tpm3", "tpa3", "ftm", "fta",
                           "oreb", "dreb", "ast", "pf", "tov", "stl", "blk", "plus_minus", "eff"]

        already_done = set()
        if os.path.exists(games_path):
            with open(games_path, encoding="utf-8") as f:
                already_done = {row["game_id"] for row in csv.DictReader(f)}
            if already_done:
                log(f"Resuming: {len(already_done)} game(s) already in {games_path} from a previous run, will be skipped.")

        games_is_new = not os.path.exists(games_path)
        rows_is_new = not os.path.exists(rows_path)
        games_f = open(games_path, "a", newline="", encoding="utf-8")
        rows_f = open(rows_path, "a", newline="", encoding="utf-8")
        games_w = csv.DictWriter(games_f, fieldnames=games_fieldnames)
        rows_w = csv.DictWriter(rows_f, fieldnames=rows_fieldnames)
        if games_is_new:
            games_w.writeheader()
        if rows_is_new:
            rows_w.writeheader()

        mismatches = 0
        scraped_count = 0
        try:
            for i, url in enumerate(game_urls, start=1):
                game_id_match = re.search(r"/games/(\d+-[A-Z]+-[A-Z]+)", url)
                game_id = game_id_match.group(1) if game_id_match else url
                if game_id in already_done:
                    continue

                if scraped_count > 0 and scraped_count % PAGE_RECYCLE_EVERY == 0:
                    log(f"  recycling the browser page after {scraped_count} games (preventive, avoids renderer memory buildup)...")
                    page.close()
                    page = new_boxscore_page(browser)

                try:
                    result = scrape_game(page, url)
                except PageCrashedError as exc:
                    log(f"  page crashed on {url} ({exc}) — opening a fresh page and retrying this game once...")
                    try:
                        page.close()
                    except PlaywrightError:
                        pass
                    page = new_boxscore_page(browser)
                    try:
                        result = scrape_game(page, url)
                    except PageCrashedError as exc2:
                        log(f"  page crashed again on {url} ({exc2}) — giving up on this game, continuing with the rest.")
                        page.close()
                        page = new_boxscore_page(browser)
                        result = None
                if result is None:
                    continue
                rows, meta = result
                for r in rows:
                    r["game_id"] = game_id
                    r["game_url"] = url

                qs = meta.get("quarter_scores")
                box_pts_a = sum(r["pts"] for r in rows if r["team"] == meta["team_a"] and not r.get("dnp"))
                box_pts_b = sum(r["pts"] for r in rows if r["team"] == meta["team_b"] and not r.get("dnp"))
                if qs and not (box_pts_a == qs["score_a"] and box_pts_b == qs["score_b"]):
                    mismatches += 1
                    log(f"  SCORE MISMATCH {game_id}: box totals {box_pts_a}-{box_pts_b} vs quarter-sum {qs['score_a']}-{qs['score_b']}")

                games_w.writerow({
                    "game_id": game_id, "game_url": url, "date": game_urls_dict[url],
                    "team_a": meta["team_a"], "team_b": meta["team_b"],
                    "score_a": qs["score_a"] if qs else box_pts_a,
                    "score_b": qs["score_b"] if qs else box_pts_b,
                })
                for r in rows:
                    rows_w.writerow({k: r.get(k, "") for k in rows_fieldnames})
                games_f.flush()
                rows_f.flush()
                scraped_count += 1

                if i % 10 == 0 or i == len(game_urls):
                    log(f"  [boxscores] {i}/{len(game_urls)} games processed, {scraped_count} newly scraped "
                        f"({mismatches} score mismatches so far)...")
        finally:
            games_f.close()
            rows_f.close()
            browser.close()

    log(f"Done — {scraped_count} game(s) newly scraped this run, {mismatches} score mismatches. "
        f"Now run the Node loader (_import_fiba_boxscore_season.js) against this --out folder.")


if __name__ == "__main__":
    sys.exit(main() or 0)
