"""
Pulls a full Greek Basket League (Stoiximan GBL) season's box scores straight
from esake.gr — no documented public API exists (confirmed: the site is
plain server-rendered HTML with no JSON endpoint), but it accepts real GET
query parameters and returns clean, parseable HTML, so this uses `requests`
+ BeautifulSoup rather than a full browser.

What this gets you, per game: real per-player box scores (points, 2PM-A,
3PM-A, FTM-A, rebounds split off/def, assists, blocks (for/against), fouls
(committed/drawn), steals, turnovers, minutes, and ESAKE's own PIR-equivalent
"RANK"). What it does NOT get you (not available anywhere on the site):
shot-location coordinates, and play-by-play (a "Play by Play" tab exists but
renders no event data via a direct URL — likely needs deeper JS interaction,
not investigated further since box scores are the valuable part).

Setup:
    pip install requests beautifulsoup4 lxml

Usage:
    python esake_gbl_season_export.py --out ./out-gbl
    python esake_gbl_season_export.py --out ./out-gbl --rounds 01,02,03   (quick test)
    python esake_gbl_season_export.py --out ./out-gbl --phase B          (playoffs instead of regular season)

Defaults to the 2025-26 Stoiximan GBL regular season (idchampionship
44B80BEB, idseason 00000001 = "Α Φάση - Κανονική Περίοδος"), rounds 01-26
(the real max is whatever the site's own round dropdown lists — it stops
early and logs a warning if a round comes back with zero games, which is
normal near the end of the season / for byes). Phase B (playoffs) uses
different round codes (QF1/QF2/.../F5) — pass them explicitly via --rounds
if you want the playoffs too, e.g.:
    python esake_gbl_season_export.py --out ./out-gbl-playoffs --phase B --rounds QF1,QF2,QF3,SF1,SF2,F1,F2,F3,F4,F5

If you hit `SSLError: CERTIFICATE_VERIFY_FAILED`, see the note in
euroleague_full_season_export.py — same local antivirus/proxy cause, same fix
(set REQUESTS_CA_BUNDLE to your interceptor's root cert).
"""

import argparse
import csv
import os
import re
import sys
import time

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.esake.gr/en/action/EsakeResults"
GAME_URL = "https://www.esake.gr/en/action/EsakegameView"
HEADERS = {"User-Agent": "Mozilla/5.0"}
REQUEST_DELAY_SECONDS = 0.5
MAX_RETRIES = 5

DEFAULT_CHAMPIONSHIP_ID = "44B80BEB"  # Stoiximan GBL 2025-2026
PHASE_IDS = {"A": "00000001", "B": "00000002"}  # regular season / "Β Φάση" (playoffs)
DEFAULT_ROUNDS_A = [f"{i:02d}" for i in range(1, 27)]  # matches the site's own round dropdown (01-26)

# Phase B's `series` query param is NOT the button label ("QF1", "F1", ...) —
# it's this internal numeric code, read straight off the site's own <select
# id="series"> dropdown (confirmed by inspecting its real <option> elements).
# Passing the label string instead (an earlier version of this script did
# exactly that) silently fails: the server doesn't recognize it and falls
# back to returning some other/incomplete result set rather than erroring,
# which is how a whole real Finals series (5 games, Olympiacos v
# Panathinaikos, decided June 13) went missing from an earlier scrape while
# looking like a normal, complete run — confirmed by direct comparison:
# series=401 correctly returns exactly the real Final Game 1, series="F1"
# (the old, wrong value) did not.
PLAYOFF_SERIES_CODES = {
    "QF1": "201", "QF2": "202", "QF3": "203",
    "SF1": "301", "SF2": "302",
    "F1": "401", "F2": "402", "F3": "403", "F4": "404", "F5": "405",
}
DEFAULT_ROUNDS_B = list(PLAYOFF_SERIES_CODES.keys())

STAT_COLUMNS = [
    "P", "2PM-A", "3PM-A", "FTM-A", "REBS", "D.REBS", "O.REBS",
    "AST", "BLK", "BLK-A", "FOULS F", "FOULS M", "STL", "TO", "TIM.PL.", "RANK",
]


def log(msg: str) -> None:
    print(f"[esake] {msg}", flush=True)


def _get(url: str, params: dict) -> BeautifulSoup:
    delay = 2.0
    last_exc = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=30)
            r.raise_for_status()
            r.encoding = "utf-8"  # the server doesn't declare a charset; utf-8 is correct (verified)
            return BeautifulSoup(r.text, "lxml")
        except requests.exceptions.RequestException as exc:
            last_exc = exc
            log(f"  request failed ({exc}), retrying in {delay:.0f}s (attempt {attempt}/{MAX_RETRIES})...")
            time.sleep(delay)
            delay = min(delay * 2, 60)
    raise last_exc


def fetch_round_games(championship_id: str, phase_id: str, series_value: str, round_label: str | None = None) -> list[dict]:
    """One round's games: date, home/away team names, scores, and the idgame
    needed to fetch that game's box score. `series_value` is the real query
    param sent to the site; `round_label` (falls back to series_value) is
    just what gets written into the CSV's `round` column for readability."""
    soup = _get(BASE_URL, {"idchampionship": championship_id, "idseason": phase_id, "series": series_value})
    round_code = round_label if round_label is not None else series_value
    games = []
    for game_div in soup.find_all("div", class_="esake-program-game"):
        stats_link = game_div.find("a", href=lambda h: h and "idgame=" in h and "mode=3" in h)
        if not stats_link:
            continue
        m = re.search(r"idgame=([0-9A-F]+)", stats_link["href"])
        if not m:
            continue
        idgame = m.group(1)

        score_block = game_div.find("div", class_="esake-program-game-final-score")
        if not score_block:
            continue
        spans = score_block.find_all("span", recursive=True)
        # Structure (see the raw HTML this was reverse-engineered from): first
        # <span> = home team name, a middle one = "H - A" score, last = away
        # team name. Team-name spans can have <br/>-joined multi-line text.
        text_parts = [s.get_text(" ", strip=True) for s in spans if s.get_text(strip=True)]
        # Filter out the score span (contains a digit-dash-digit pattern) to isolate team names.
        score_text = next((t for t in text_parts if re.match(r"^\d+\s*-\s*\d+$", t)), None)
        team_texts = [t for t in text_parts if t != score_text]
        if not score_text or len(team_texts) < 2:
            continue
        home_score, away_score = (int(x.strip()) for x in score_text.split("-"))
        home_team, away_team = team_texts[0], team_texts[-1]

        date_div = game_div.find("div", class_="esake-program-game-info")
        date_text = date_div.get_text(" ", strip=True) if date_div else ""

        games.append({
            "idgame": idgame, "round": round_code, "date_text": date_text,
            "home_team": home_team, "away_team": away_team,
            "home_score": home_score, "away_score": away_score,
        })
    return games


def parse_minutes(s: str) -> float:
    """'00:17:11' -> 17.183 decimal minutes."""
    m = re.match(r"^(\d+):(\d+):(\d+)$", s.strip())
    if not m:
        return 0.0
    h, mm, ss = (int(x) for x in m.groups())
    return h * 60 + mm + ss / 60


def parse_made_attempted(s: str) -> tuple[int, int]:
    """'3 - 5' -> (3, 5)."""
    parts = re.split(r"\s*-\s*", s.strip())
    if len(parts) != 2:
        return (0, 0)
    try:
        return (int(parts[0]), int(parts[1]))
    except ValueError:
        return (0, 0)


def fetch_boxscore(idgame: str, home_score: int, away_score: int) -> list[dict]:
    """Every real player-game row from both teams' box-score tables, tagged
    'home'/'away' by matching each table's TOTAL points against the already-
    known final score (the box-score page itself has no team-name label on
    the tables, only team logos with no alt text)."""
    soup = _get(GAME_URL, {"idgame": idgame, "mode": "3"})
    tables = soup.find_all("table", class_="table-sorter")
    if len(tables) != 2:
        log(f"  idgame {idgame}: expected 2 box-score tables, found {len(tables)} — skipping.")
        return []

    rows_out = []
    for table in tables:
        trs = table.find_all("tr")
        header_cells = [c.get_text(" ", strip=True) for c in trs[1].find_all("th")] if len(trs) > 1 else []
        col_index = {name: i for i, name in enumerate(header_cells)}
        if not all(c in col_index for c in STAT_COLUMNS):
            log(f"  idgame {idgame}: unexpected table header shape, skipping this table.")
            continue

        total_pts = None
        player_rows = []
        for tr in trs[2:]:
            cells = tr.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            label = cells[0].get_text(" ", strip=True)
            values = [c.get_text(" ", strip=True) for c in cells]
            if label == "TOTAL":
                total_pts = int(values[col_index["P"]]) if values[col_index["P"]].strip().lstrip("-").isdigit() else None
                continue
            if label in ("TΕΑΜ - BENCH", "TEAM - BENCH"):
                continue  # unattributed team rebounds/fouls/TOs — no single player to credit

            # Jersey prefix is "#N " (a real number) or "## " (no number assigned) — consume ALL leading '#'s.
            m = re.match(r"^#+\s*(\d*)\s*(.+)$", label)
            if not m:
                continue
            dorsal, name = m.group(1), m.group(2).strip()

            fgm2, fga2 = parse_made_attempted(values[col_index["2PM-A"]])
            tpm, tpa = parse_made_attempted(values[col_index["3PM-A"]])
            ftm, fta = parse_made_attempted(values[col_index["FTM-A"]])

            def _int(col):
                v = values[col_index[col]].strip()
                return int(v) if v.lstrip("-").isdigit() else 0

            player_rows.append({
                "dorsal": dorsal, "name": name,
                "pts": _int("P"), "fgm2": fgm2, "fga2": fga2, "tpm": tpm, "tpa": tpa, "ftm": ftm, "fta": fta,
                "dreb": _int("D.REBS"), "oreb": _int("O.REBS"), "ast": _int("AST"),
                "blk": _int("BLK"), "blk_against": _int("BLK-A"),
                "pf": _int("FOULS F"), "pfd": _int("FOULS M"),
                "stl": _int("STL"), "tov": _int("TO"),
                "minutes": parse_minutes(values[col_index["TIM.PL."]]),
                "rank": values[col_index["RANK"]],
            })

        side = "home" if total_pts == home_score else "away" if total_pts == away_score else "unknown"
        if side == "unknown":
            log(f"  idgame {idgame}: table total {total_pts} matched neither home ({home_score}) nor away ({away_score}) score.")
        for row in player_rows:
            row["side"] = side
            row["idgame"] = idgame
            rows_out.append(row)

    return rows_out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=str, default="./out-gbl", help="Output folder for CSVs")
    ap.add_argument("--championship-id", type=str, default=DEFAULT_CHAMPIONSHIP_ID,
                     help="ESAKE's internal id for the season (default: 2025-26 Stoiximan GBL)")
    ap.add_argument("--phase", type=str, default="A", choices=["A", "B"],
                     help="A = regular season (default), B = playoffs (needs --rounds with series codes)")
    ap.add_argument("--rounds", type=str, default=None,
                     help="Comma-separated round labels to fetch. Defaults to 01-26 for phase A, "
                          "QF1,QF2,QF3,SF1,SF2,F1,F2,F3,F4,F5 for phase B.")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    phase_id = PHASE_IDS[args.phase]
    rounds = args.rounds.split(",") if args.rounds else (DEFAULT_ROUNDS_A if args.phase == "A" else DEFAULT_ROUNDS_B)
    if not rounds:
        log("No rounds to fetch. Exiting.")
        return

    # For playoff series (phase B), the site keeps returning the SAME already-
    # decided games under every remaining round_code once a series has ended
    # early (e.g. a best-of-5 final that finished in 3 games still returns
    # those same 3 games' idgame when queried under series=F4 and F5) — so
    # naively concatenating every round's results duplicates real games once
    # per extra round_code queried. Dedupe by idgame (the site's own stable
    # per-game id), keeping the first-seen row, so the same real game is
    # never written to games.csv/player_boxscores.csv more than once.
    all_games = []
    seen_idgames = set()
    for round_code in rounds:
        # Phase A's own round labels ("01".."26") ARE the real query value;
        # phase B's labels ("QF1", "F1", ...) are display-only and must be
        # translated to the site's internal numeric series code first.
        series_value = PLAYOFF_SERIES_CODES.get(round_code, round_code) if args.phase == "B" else round_code
        log(f"Fetching round {round_code} (series={series_value})...")
        games = fetch_round_games(args.championship_id, phase_id, series_value, round_label=round_code)
        if not games:
            log(f"  round {round_code}: 0 games found (bye week, or past the end of the season).")
        new_games = [g for g in games if g["idgame"] not in seen_idgames]
        skipped = len(games) - len(new_games)
        if skipped:
            log(f"  round {round_code}: skipped {skipped} game(s) already seen under an earlier round code.")
        for g in new_games:
            seen_idgames.add(g["idgame"])
        all_games.extend(new_games)
        time.sleep(REQUEST_DELAY_SECONDS)

    log(f"Found {len(all_games)} unique games total across {len(rounds)} rounds.")
    games_path = os.path.join(args.out, "games.csv")
    with open(games_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["idgame", "round", "date_text", "home_team", "away_team", "home_score", "away_score"])
        w.writeheader()
        w.writerows(all_games)
    log(f"Wrote {games_path}")

    all_rows = []
    for i, g in enumerate(all_games, start=1):
        rows = fetch_boxscore(g["idgame"], g["home_score"], g["away_score"])
        all_rows.extend(rows)
        if i % 20 == 0 or i == len(all_games):
            log(f"  [boxscores] {i}/{len(all_games)} games fetched...")
        time.sleep(REQUEST_DELAY_SECONDS)

    boxscores_path = os.path.join(args.out, "player_boxscores.csv")
    with open(boxscores_path, "w", newline="", encoding="utf-8") as f:
        fieldnames = ["idgame", "side", "dorsal", "name", "pts", "fgm2", "fga2", "tpm", "tpa", "ftm", "fta",
                      "dreb", "oreb", "ast", "blk", "blk_against", "pf", "pfd", "stl", "tov", "minutes", "rank"]
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(all_rows)
    log(f"Wrote {boxscores_path} ({len(all_rows)} player-game rows)")

    log("Done. Now run the Node loader (_import_esake_gbl_season.js) against this --out folder.")


if __name__ == "__main__":
    sys.exit(main() or 0)
