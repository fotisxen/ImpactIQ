"""
Pulls a full Basketball Champions League season's box scores from
fiba.basketball — every phase: Regular Season, Play-Ins, Round of 16,
Quarter-Finals, Final Four. Uses the SAME approach as
fiba_europe_cup_season_export.py (real browser via Playwright — the box
score data only renders after JS runs and a tab is clicked, plain HTTP
requests can't see it, and default headless Chromium gets blocked by the
site's bot-protection without the launch flags used below).

Important, hard-won distinction from the FIBA Europe Cup script: BCL's
*current-season* microsite (championsleague.basketball) PRUNES completed
seasons' game pages once a new season starts — confirmed by finding a real,
Google-indexed 2025-26 Final page that now 404s there. The stable, permanent
archive lives instead under fiba.basketball's own history section:
    https://www.fiba.basketball/en/history/<competition-id>/<season-id>/games
This is what this script uses. If a future season's <season-id> needs
updating, find it by searching "site:fiba.basketball history basketball
champions league <season>" — the history event page's own URL contains it.

What this gets you, per game: the same rich box score as FIBA Europe Cup
(points, FG/2PT/3PT/FT makes-attempts, rebounds off/def, assists, fouls,
turnovers, steals, blocks, +/-, EFF rating).

Setup:
    pip install playwright beautifulsoup4
    python -m playwright install chromium   (skip if already installed for the FIBA Europe Cup script)

Usage:
    python bcl_season_export.py --out ./out-bcl
    python bcl_season_export.py --out ./out-bcl --phases "Regular Season"   (quick test, regular season only)

Phases scraped by default: Regular Season (all games on one page, no button
needed) + Play-ins + Round of 16 + Quarter-Finals + Final Four (each behind
its own filter button). Pass --phases to restrict to a subset for testing,
e.g. --phases "Play-ins,Final Four".
"""

import argparse
import csv
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError

PAGE_RECYCLE_EVERY = 25  # close + reopen the page periodically — a long-lived tab across 100+ real
                          # page loads eventually crashes the renderer (confirmed empirically: "Target
                          # crashed" partway through a 176-game run). Recycling keeps memory bounded.


class PageCrashedError(Exception):
    """Raised when the page's renderer itself died — the page object is unusable
    after this, retrying on it is pointless; the caller must open a fresh one."""

HISTORY_EVENT_URL = "https://www.fiba.basketball/en/history/112-fiba-mens-european-club-competitions-tier-1/208962"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
PLAYOFF_PHASE_BUTTONS = ["Play-ins", "Round of 16", "Quarter-Finals", "Final Four"]
ALL_PHASES = ["Regular Season"] + PLAYOFF_PHASE_BUTTONS

MONTHS = {"January": "01", "February": "02", "March": "03", "April": "04", "May": "05", "June": "06",
          "July": "07", "August": "08", "September": "09", "October": "10", "November": "11", "December": "12"}
DATE_RE = re.compile(r"^(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$")


def log(msg: str) -> None:
    print(f"[bcl] {msg}", flush=True)


def date_text_to_iso(text: str) -> str | None:
    m = DATE_RE.match(text.strip())
    if not m:
        return None
    day, month_name, year = m.groups()
    return f"{year}-{MONTHS[month_name]}-{int(day):02d}"


def parse_made_attempted(s: str):
    m = re.match(r"^(\d+)\s*/\s*(\d+)", s.strip())
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def parse_boxscore_table_html(table_html: str, team_name: str) -> list[dict]:
    """Identical structure/logic to fiba_europe_cup_season_export.py's parser
    — same underlying FIBA platform template, confirmed by direct inspection
    (18 cells for a played row, 4 for DNP, same column order)."""
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


def parse_quarter_scores(overview_text: str) -> dict | None:
    lines = [l.strip() for l in overview_text.split("\n") if l.strip() != ""]
    try:
        idx = lines.index("Q4")
    except ValueError:
        return None
    try:
        vals = lines[idx + 1: idx + 11]
        code_a, q1a, q2a, q3a, q4a, code_b, q1b, q2b, q3b, q4b = vals
        return {
            "code_a": code_a, "score_a": sum(int(x) for x in (q1a, q2a, q3a, q4a)),
            "code_b": code_b, "score_b": sum(int(x) for x in (q1b, q2b, q3b, q4b)),
        }
    except (ValueError, IndexError):
        return None


def new_boxscore_page(browser):
    return browser.new_page(viewport={"width": 1280, "height": 1000}, user_agent=USER_AGENT)


def accept_cookies(page) -> None:
    try:
        page.get_by_role("button", name="I accept", exact=True).first.click(timeout=4000)
    except PlaywrightTimeoutError:
        pass


def collect_games_for_current_view(page) -> dict[str, str]:
    """Extracts every game link currently visible on the page, each paired
    with the nearest preceding date heading (both Regular Season's continuous
    list and each playoff-phase filtered view use the same date-heading +
    game-card layout)."""
    pairs = page.evaluate("""
        () => {
            const main = document.querySelector('main');
            const walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT);
            const dateRe = /^\\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \\d{4}$/;
            let currentDate = null;
            const results = [];
            let node;
            while ((node = walker.nextNode())) {
                const onlyChildIsText = node.childNodes.length === 1 && node.childNodes[0].nodeType === 3;
                const txt = onlyChildIsText ? node.textContent.trim() : null;
                if (txt && dateRe.test(txt)) currentDate = txt;
                if (node.tagName === 'A' && /\\/games\\//.test(node.href) && !node.href.endsWith('/games')) {
                    results.push([node.href, currentDate]);
                }
            }
            return results;
        }
    """)
    return {href: date for href, date in pairs}


def scrape_game(page, url: str) -> tuple[list[dict], dict] | None:
    for attempt in range(1, 4):
        try:
            page.goto(url, timeout=45000, wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
            accept_cookies(page)
            page.wait_for_timeout(500)

            overview_text = page.inner_text("main")
            quarter_scores = parse_quarter_scores(overview_text)

            page.locator("button").filter(has_text=re.compile("^Boxscore")).first.click(timeout=15000)
            page.wait_for_timeout(1200)

            headings = page.locator("h1, h2, h3, h4").all_text_contents()
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

            return rows, {"team_a": team_a_name, "team_b": team_b_name, "quarter_scores": quarter_scores}
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
    ap.add_argument("--out", type=str, default="./out-bcl", help="Output folder for CSVs")
    ap.add_argument("--phases", type=str, default=None,
                     help=f"Comma-separated phases to scrape. Default: all of {ALL_PHASES}.")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    phases = args.phases.split(",") if args.phases else ALL_PHASES

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        page = new_boxscore_page(browser)

        log(f"Loading the games list page ({HISTORY_EVENT_URL}/games)...")
        page.goto(f"{HISTORY_EVENT_URL}/games", timeout=60000, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        accept_cookies(page)
        page.wait_for_timeout(800)

        url_to_date: dict[str, str] = {}
        url_to_phase: dict[str, str] = {}

        if "Regular Season" in phases:
            found = collect_games_for_current_view(page)
            for u, d in found.items():
                url_to_date[u] = d
                url_to_phase[u] = "Regular Season"
            log(f"Regular Season: {len(found)} games found.")

        for phase in [p for p in phases if p in PLAYOFF_PHASE_BUTTONS]:
            try:
                page.locator("button").filter(has_text=re.compile(f"^{re.escape(phase)}$")).first.click(timeout=8000)
                page.wait_for_timeout(1500)
            except PlaywrightTimeoutError:
                log(f"  could not click phase button {phase!r}, skipping.")
                continue
            found = collect_games_for_current_view(page)
            new_count = 0
            for u, d in found.items():
                if u not in url_to_date:
                    new_count += 1
                url_to_date[u] = d
                url_to_phase[u] = phase
            log(f"{phase}: {len(found)} games found ({new_count} new).")

        log(f"Total unique games across all requested phases: {len(url_to_date)}")
        game_urls = sorted(url_to_date.keys())

        # Resume support: a game_id already present in games.csv from a
        # previous (interrupted) run is skipped rather than re-scraped.
        games_path = os.path.join(args.out, "games.csv")
        rows_path = os.path.join(args.out, "player_boxscores.csv")
        games_fieldnames = ["game_id", "game_url", "date", "phase", "team_a", "team_b", "score_a", "score_b"]
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
                    log(f"  recycling the browser page after {scraped_count} games (preventive, avoids the renderer memory buildup that caused the earlier crash)...")
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

                date_text = url_to_date.get(url)
                games_w.writerow({
                    "game_id": game_id, "game_url": url,
                    "date": date_text_to_iso(date_text) if date_text else "",
                    "phase": url_to_phase.get(url, ""),
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
