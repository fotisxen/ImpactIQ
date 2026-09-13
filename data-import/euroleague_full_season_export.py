"""
Pulls EVERYTHING the app needs for one full EuroLeague season — Regular
Season + Play-Ins + Playoffs + Final Four, all in one pass — straight from
EuroLeague's own public API (via the `euroleague_api` package) and writes it
to plain CSV files. A separate Node script (`_import_euroleague_full_season.js`,
next to this file) reads those CSVs and loads them into the app's database.

Why this covers every phase automatically: EuroLeague's own `gameCode` is
sequential across the WHOLE season (regular season, play-ins, playoffs, and
Final Four games are just later gamecodes in the same sequence). This script
fetches every played gamecode itself, one game at a time, with retry/backoff
on rate limits — the `Phase` column (values "RS" / "PI" / "PO" / "FF") on
every row tells you which is which.

Setup:
    pip install euroleague-api pandas requests

Usage:
    python euroleague_full_season_export.py --season 2025 --out ./out

`--season` is the EuroLeague season CODE, i.e. the year it *started* in —
2025 means the 2025-26 season. `--out` is the folder CSVs get written to
(created if missing). This makes ~4 API calls per game (box score, PBP, shot
data, plus the schedule once) — for a full season (~400 games incl. play-ins/
playoffs/Final Four) that's roughly 1600 requests. With the built-in 0.3s
courtesy delay between requests that's ~10-15 minutes; expect it to take
longer if you hit rate limits (the script backs off and retries automatically
rather than failing).

Do a fast sanity-check run first with a small slice, e.g.:
    python euroleague_full_season_export.py --season 2025 --out ./test_out --limit-games 12
before committing to the full multi-hundred-game pull.

If you hit `SSLError: CERTIFICATE_VERIFY_FAILED`, it almost always means a
local antivirus/corporate proxy is intercepting HTTPS and your Python isn't
set up to trust its root certificate (Node/your browser usually already do,
which is why only Python complains). Find that root cert (on Windows with
Avast, e.g. `C:\\ProgramData\\Avast Software\\Avast\\wscert.pem`) and either:
    set REQUESTS_CA_BUNDLE=C:\\path\\to\\that\\cert.pem
or merge it into your certifi bundle. This is a local machine-trust issue,
not a problem with EuroLeague's API or this script.
"""

import argparse
import os
import sys
import time

import pandas as pd
from requests.exceptions import HTTPError

from euroleague_api.boxscore_data import BoxScoreData
from euroleague_api.play_by_play_data import PlayByPlay
from euroleague_api.shot_data import ShotData
from euroleague_api.team_stats import TeamStats

REQUEST_DELAY_SECONDS = 0.3
MAX_RETRIES = 8
MAX_BACKOFF_SECONDS = 120


def log(msg: str) -> None:
    print(f"[export] {msg}", flush=True)


def fetch_schedule(season: int, competition: str = "E") -> pd.DataFrame:
    """
    The authoritative game list for the whole season, every phase, with real
    dates and a clean plain-int join key (`gameCode`). Deliberately NOT using
    `Schedule.get_schedule()` here — its own `gamecode` column comes back
    prefixed ("E2025_7"), which doesn't match the plain-int `Gamecode` column
    every other endpoint (box scores, PBP, shot data) uses, so joining against
    it silently produces nothing but NaNs. `get_gamecodes_season` already
    carries the real `Phase` (RS/PI/PO/FF) and a plain-int `gameCode` — use that.
    """
    log("Fetching schedule (all phases: RS/PI/PO/FF)...")
    b = BoxScoreData(competition=competition)
    delay = 2.0
    df = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            df = b.get_gamecodes_season(season=season)
            break
        except HTTPError as err:
            status = err.response.status_code if err.response is not None else None
            if status == 429 and attempt < MAX_RETRIES:
                log(f"  rate limited (429), retrying in {delay:.0f}s (attempt {attempt}/{MAX_RETRIES})...")
                time.sleep(delay)
                delay = min(delay * 2, MAX_BACKOFF_SECONDS)
                continue
            raise
    df = df[df["played"]].reset_index(drop=True)
    log(f"  {len(df)} played games total, phases: {df['Phase'].value_counts().to_dict()}")
    return df


def _fetch_one_with_retry(fetch_one, season, gamecode):
    """
    The package's own per-game methods have no retry/backoff at all, and a
    full-season pull (~1600 requests) reliably trips EuroLeague's rate limit
    partway through (confirmed empirically: a plain 429 after a few dozen
    rapid calls). Retry with exponential backoff on 429s specifically; other
    HTTP errors (e.g. a genuinely missing gamecode) are logged and skipped,
    matching the package's own "skip and continue" philosophy.
    """
    delay = 2.0
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fetch_one(season=season, gamecode=gamecode)
        except HTTPError as err:
            status = err.response.status_code if err.response is not None else None
            if status == 429 and attempt < MAX_RETRIES:
                log(f"  gamecode {gamecode}: rate limited (429), retrying in {delay:.0f}s "
                    f"(attempt {attempt}/{MAX_RETRIES})...")
                time.sleep(delay)
                delay = min(delay * 2, MAX_BACKOFF_SECONDS)
                continue
            log(f"  gamecode {gamecode}: HTTP error, skipping. {err}")
            return pd.DataFrame()
        except Exception as exc:  # noqa: BLE001 — one bad game shouldn't kill a multi-hour run
            log(f"  gamecode {gamecode}: unexpected error, skipping. {exc}")
            return pd.DataFrame()
    return pd.DataFrame()


def _per_game(fetch_one, season, gamecodes, schedule, label):
    """Loops the per-game endpoint across every requested gamecode, with a
    courtesy delay + retry/backoff (see _fetch_one_with_retry), stitching
    Phase/Round onto each game's rows so every output CSV is self-describing."""
    lookup = schedule.set_index("gameCode")[["Phase", "Round"]]
    frames = []
    total = len(gamecodes)
    for i, gc in enumerate(gamecodes, start=1):
        df = _fetch_one_with_retry(fetch_one, season, gc)
        if df is not None and not df.empty:
            if "Phase" not in df.columns:
                df.insert(1, "Phase", lookup.loc[gc, "Phase"])
            if "Round" not in df.columns:
                df.insert(2, "Round", lookup.loc[gc, "Round"])
            frames.append(df)
        if i % 25 == 0 or i == total:
            log(f"  [{label}] {i}/{total} games fetched...")
        time.sleep(REQUEST_DELAY_SECONDS)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def fetch_player_boxscores(season: int, schedule: pd.DataFrame, gamecodes, competition: str = "E") -> pd.DataFrame:
    """Official per-player, per-game box score lines for every played game, every phase."""
    log("Fetching player box scores...")
    b = BoxScoreData(competition=competition)
    df = _per_game(b.get_players_boxscore_stats, season, gamecodes, schedule, "boxscores")
    log(f"  {len(df)} player-game rows.")
    return df


def fetch_play_by_play(season: int, schedule: pd.DataFrame, gamecodes, competition: str = "E") -> pd.DataFrame:
    """Full event-level play-by-play for every played game, every phase."""
    log("Fetching play-by-play (needed to rebuild on-court lineups / possessions)...")
    p = PlayByPlay(competition=competition)
    df = _per_game(p.get_game_play_by_play_data, season, gamecodes, schedule, "play-by-play")
    log(f"  {len(df)} PBP event rows.")
    return df


def fetch_shot_data(season: int, schedule: pd.DataFrame, gamecodes, competition: str = "E") -> pd.DataFrame:
    """
    Every shot attempt, every game, every phase — with EuroLeague's OWN
    FASTBREAK / SECOND_CHANCE / POINTS_OFF_TURNOVER flags already attached
    per shot. This is the direct source for those "missing" team stats —
    they were never actually missing from the API, just not exposed via the
    TeamStats aggregate endpoints (confirmed by inspecting every stat_category
    TeamStats.get_team_stats_leaders supports — none of the 4 appear there).
    """
    log("Fetching shot data (shot charts + fastbreak/second-chance/points-off-TO flags)...")
    s = ShotData(competition=competition)
    df = _per_game(s.get_game_shot_data, season, gamecodes, schedule, "shot data")
    log(f"  {len(df)} shot rows.")
    return df


def fetch_team_advanced_official(season: int, competition: str = "E") -> dict:
    """
    Official team-level traditional/advanced stat lines for the season, for a
    sanity cross-check only (PIR, eFG%, shooting splits) — NOT the source of
    the 4 "missing" stats, which don't exist at this level (see
    fetch_shot_data's docstring — confirmed by inspecting the full
    stat_category list TeamStats.get_team_stats_leaders documents; none of
    Points-in-Paint/Fastbreak/Second-Chance/Points-off-Turnovers appear there).
    Regular season only (phase_type_code="RS") since that's the phase the
    app's own possession-reconstruction estimate is most commonly compared
    against; re-run with "PO"/"FF" yourself if you want those too.
    """
    log("Fetching official team traditional/advanced stats (RS) for cross-checking...")
    ts = TeamStats(competition=competition)
    out = {}
    for endpoint in ("traditional", "advanced", "opponentsTraditional", "opponentsAdvanced"):
        out[endpoint] = ts.get_team_stats_single_season(
            endpoint=endpoint, season=season, phase_type_code="RS", statistic_mode="PerGame"
        )
    return out


# Empirically derived, not an official EuroLeague zone legend (their shot-data
# API returns raw court coordinates + a 9-letter zone code A-I with no public
# documentation of what each letter means). Verified across 5 real games by
# clustering shot distance-from-basket per zone letter:
#   A: mean dist ~20 (rim)               D/E: mean dist ~330 (mid-range)
#   B/C: mean dist ~145 (short paint)    F/G: mean dist ~490 (long 2)
#                                        H/I: mean dist ~780 (3-pointers, left/right)
# "Points in the Paint" = A+B+C, matching the distance cluster that sits
# inside a realistic paint/key boundary in this coordinate system.
PAINT_ZONES = {"A", "B", "C"}


def _merged_write(path, new_df, key_col):
    """
    Writes new_df to path — merged with whatever's already there, if
    anything. Existing rows whose key_col value also appears in new_df are
    replaced (not duplicated); everything else is kept as-is. This is what
    makes --gamecodes a real backfill instead of an overwrite: re-fetching
    just the games that failed on a previous run adds them in without
    wiping the ~390 games that already succeeded.
    """
    if os.path.exists(path) and os.path.getsize(path) > 0:
        existing = pd.read_csv(path, dtype={key_col: str})
        new_df = new_df.copy()
        new_df[key_col] = new_df[key_col].astype(str)
        existing = existing[~existing[key_col].isin(new_df[key_col])]
        combined = pd.concat([existing, new_df], ignore_index=True)
    else:
        combined = new_df
    combined.to_csv(path, index=False)
    return combined


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, required=True, help="Season start year, e.g. 2025 for 2025-26")
    ap.add_argument("--out", type=str, default="./out", help="Output folder for CSVs")
    ap.add_argument(
        "--competition", type=str, default="E", choices=["E", "U"],
        help="'E' for EuroLeague (default), 'U' for EuroCup. Same package, same script, just a different "
             "competition code — this is the ONLY thing that changes between the two.",
    )
    ap.add_argument(
        "--limit-games", type=int, default=None,
        help="Debug/dry-run only: pull just the first N played games instead of the whole season. "
             "Use this first to sanity-check the pipeline and the Node loader in a couple minutes.",
    )
    ap.add_argument(
        "--gamecodes", type=str, default=None,
        help="Backfill mode: comma-separated gamecodes to (re-)fetch, e.g. --gamecodes 30,61,92 — "
             "useful after a full run left a few games missing (rate-limit casualties are logged during "
             "the run, or check for gamecodes present in games.csv but absent from player_boxscores.csv). "
             "Results are MERGED into the existing CSVs in --out (replacing just those gamecodes), not "
             "overwritten, so this is safe to run against the same --out folder as your full pull.",
    )
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    season = args.season
    competition = args.competition
    is_backfill = bool(args.gamecodes)

    schedule = fetch_schedule(season, competition)
    if args.gamecodes:
        keep = [int(x) for x in args.gamecodes.split(",")]
        schedule_slice = schedule[schedule["gameCode"].isin(keep)].reset_index(drop=True)
        log(f"--gamecodes set: backfilling {len(schedule_slice)} games: {keep}")
    elif args.limit_games:
        keep = schedule["gameCode"].head(args.limit_games).tolist()
        schedule_slice = schedule[schedule["gameCode"].isin(keep)].reset_index(drop=True)
        log(f"--limit-games set: restricting to {len(keep)} games: {keep}")
    else:
        schedule_slice = schedule
    gamecodes = schedule_slice["gameCode"].tolist()

    schedule_path = os.path.join(args.out, "games.csv")
    if is_backfill:
        _merged_write(schedule_path, schedule_slice, "gameCode")
    else:
        schedule_slice.to_csv(schedule_path, index=False)
    log(f"Wrote {schedule_path}")

    boxscores = fetch_player_boxscores(season, schedule_slice, gamecodes, competition)
    sched_lookup = schedule_slice.set_index("gameCode")[["date"]]
    boxscores = boxscores.join(sched_lookup, on="Gamecode")
    boxscores_path = os.path.join(args.out, "player_boxscores.csv")
    if is_backfill:
        _merged_write(boxscores_path, boxscores, "Gamecode")
    else:
        boxscores.to_csv(boxscores_path, index=False)
    log(f"Wrote {boxscores_path}")

    pbp = fetch_play_by_play(season, schedule_slice, gamecodes, competition)
    pbp_path = os.path.join(args.out, "play_by_play.csv")
    if is_backfill:
        _merged_write(pbp_path, pbp, "Gamecode")
    else:
        pbp.to_csv(pbp_path, index=False)
    log(f"Wrote {pbp_path}")

    shots = fetch_shot_data(season, schedule_slice, gamecodes, competition)
    shots_path = os.path.join(args.out, "shot_data.csv")
    if is_backfill:
        _merged_write(shots_path, shots, "Gamecode")
    else:
        shots.to_csv(shots_path, index=False)
    log(f"Wrote {shots_path}")

    log("Aggregating official team-game advanced stats from shot flags...")
    if shots.empty:
        log("WARNING: no shot data fetched, skipping team_game_advanced_stats.csv")
    else:
        # FASTBREAK/SECOND_CHANCE/POINTS_OFF_TURNOVER come back as the
        # STRINGS "0"/"1" from the API, not real booleans/ints.
        shots["_fastbreak"] = shots["FASTBREAK"].astype(str) == "1"
        shots["_second_chance"] = shots["SECOND_CHANCE"].astype(str) == "1"
        shots["_points_off_to"] = shots["POINTS_OFF_TURNOVER"].astype(str) == "1"
        shots["_paint"] = shots["ZONE"].isin(PAINT_ZONES)
        agg = (
            shots.groupby(["Gamecode", "TEAM"])
            .apply(
                lambda g: pd.Series(
                    {
                        "points_off_turnovers": g.loc[g["_points_off_to"], "POINTS"].sum(),
                        "second_chance_points": g.loc[g["_second_chance"], "POINTS"].sum(),
                        "fastbreak_points": g.loc[g["_fastbreak"], "POINTS"].sum(),
                        "points_in_the_paint": g.loc[g["_paint"], "POINTS"].sum(),
                    }
                ),
                include_groups=False,
            )
            .reset_index()
        )
        team_adv_path = os.path.join(args.out, "team_game_advanced_stats.csv")
        if is_backfill:
            _merged_write(team_adv_path, agg, "Gamecode")
        else:
            agg.to_csv(team_adv_path, index=False)
        log(f"Wrote {team_adv_path}")

    if is_backfill:
        log("Backfill complete — skipping the official team-stats cross-check fetch (season-level, not per-game).")
        log("Done. Re-run the Node loader's --import against this --out folder to pick up the backfilled games.")
        return

    try:
        official = fetch_team_advanced_official(season, competition)
        for endpoint, df in official.items():
            p = os.path.join(args.out, f"team_stats_official_{endpoint}.csv")
            df.to_csv(p, index=False)
            log(f"Wrote {p}")
    except Exception as exc:  # noqa: BLE001 — this part is a cross-check only, never fatal
        log(f"WARNING: official team-stats cross-check fetch failed, skipping: {exc}")

    log("Done. Now run the Node loader against this --out folder to get it into the app's DB.")


if __name__ == "__main__":
    sys.exit(main() or 0)
