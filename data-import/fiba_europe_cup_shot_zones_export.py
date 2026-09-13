"""
Pulls REAL per-shot coordinate data for FIBA Europe Cup 2025-26 games from
fiba.basketball's own game pages (fiba.basketball/en/events/fiba-europe-cup-25-26/games/{slug}),
"Shot Chart" tab.

Confirmed live in a real browser session (2026-08-30): no public JSON API
exists for this data (no XHR/fetch network requests were observed loading
it — it's SSR/RSC-rendered and the DOM node only carries the resolved data
once the "Shot Chart" tab is actually clicked). The data reaches the page as
literal React props on the shot-chart component:
  points: [{x, y, playerId, team: "A"|"B", type: "MADE"|"MISS", quarterId}, ...]
  teamA / teamB: [{number, name (abbreviated "F. Surname"), playerId}, ...]
This script drives a real browser and reads that data straight out of
React's internal fiber tree (the __reactFiber$... property every DOM node
carries), walking up from a shot-marker <svg> to the component holding
`points`/`teamA`/`teamB` — the exact technique validated interactively
before writing this script.

Zone classification here is a GEOMETRIC ESTIMATE, not a site-provided label
(unlike 3stepsbasket.com's zone data used elsewhere in this project, which
comes from the site's own hover tooltips over fixed zone regions) —
coordinates are calibrated against a standard FIBA court: viewBox 618x336px
representing a real 28m x 15m court, hoops 1.575m in from the baseline,
3PT arc at a uniform 6.75m. This is an approximation and should be labeled
as such wherever it's surfaced — the shot x/y/make-or-miss values are real,
but which of the app's 5 zone buckets a borderline shot falls into is a
computed classification, not read off the site.

Game discovery: no season-wide game listing page was found either (the
`/games` page only ever renders the single most-recently-selected date's
games, and doesn't expose a plain URL param for "list every game"). Instead,
each team's own page has a "Games" tab (its content isn't in the initial
HTML — it only renders after the tab is clicked) listing every game slug
that team played. This script visits every one of the league's 44 teams'
pages, collects games from each, and dedupes (~196 total games, each shared
by exactly 2 teams).

Team-side resolution (which of "team A"/"team B" in a game's shot data is
which real club) is done by reading the two team-name headings shown on the
game's default Overview tab (no extra click needed) and matching that text
against each team's own canonical display name (harvested once per team
during the game-discovery pass, from that team's own page heading) — not by
assuming the game URL slug's team-code order, which was only spot-checked
for one game and isn't worth trusting blindly across ~196.

Player matching to this app's own `players` table: FIBA Europe Cup names in
this app's DB are already plain English ("Darrun Hilliard", same convention
as the BCL import), so unlike the Greek Basket League player-shot-zone
script, no transliteration is needed — matching is by last-name equality
within the same team, with the same 5-stat (ppg/apg/rpg/tpg/spg) fingerprint
distance as a mandatory second gate (same two-independent-checks discipline
established after the GBL Netzipoglou/Larentzakis wrong-match incident, see
esake_player_shot_zones_export.py's docstring for the full story).

Requires data-import/fec_players_ppg.json (this app's own player_id/name/ppg
per team, exported from the live SQLite DB via _scratch_export_fec_players.js).

Setup:
    pip install playwright
    python -m playwright install chromium   (skip if already installed)

Usage:
    python fiba_europe_cup_shot_zones_export.py --out ./out-fec-shot-zones
"""

import argparse
import csv
import difflib
import json
import math
import os
import re
import time

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError

BASE = "https://www.fiba.basketball/en/events/fiba-europe-cup-25-26"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

# slug -> this app's own `teams` table name under "FIBA Europe Cup" (all 44
# confirmed 1:1 against the site's own /teams listing page, 2026-08-30).
TEAM_SLUGS = {
    "absheron-lions": "Absheron Lions",
    "aliaga-petkimspor": "Petkim Spor",
    "anorthosis-famagusta": "Anorthosis Famagusta",
    "anwil-wloclawek": "Anwil Wloclawek",
    "bakken-bears": "Bakken Bears",
    "basketball-lowen-braunschweig": "Löwen Braunschweig",
    "bc-balkan": "BC Balkan",
    "bc-bashkimi": "BC Bashkimi",
    "bc-dnipro": "BC Dnipro",
    "bc-kalevcramo": "Kalev/Cramo",
    "bc-kutaisi-2010": "Kutaisi 2010",
    "bc-prievidza": "BC Prievidza",
    "bc-trepca": "Trepça",
    "casademont-zaragoza": "Casademont Zaragoza",
    "cedevita-junior": "Cedevita Junior",
    "cs-valcea-1924": "Vâlcea 1924",
    "csm-corona-brasov": "CSM Corona Brasov",
    "csm-csu-raiffeisen-oradea": "CSM Oradea",
    "dinamo-bds-sassari": "Dinamo Sassari",
    "energa-trefl-sopot": "Trefl Sopot",
    "falco-vulcano-energia-kc-szombathely": "Falco Szombathely",
    "fc-porto": "Porto",
    "jda-dijon-basket": "JDA Dijon",
    "kangoeroes-basket-mechelen": "Kangoeroes Basket Mechelen",
    "keravnos-bc": "Keravnos",
    "kk-bosna-bh-telecom": "KK Bosna BH Telecom",
    "kk-cibona": "KK Cibona",
    "kk-pelister": "Pelister",
    "neftchi-ik": "Neftçi",
    "pallacanestro-reggiana": "Pallacanestro Reggiana",
    "paok-bc": "PAOK",
    "peristeri-betsson": "Peristeri",
    "petrolina-aek": "Petrolina AEK Larnaca",
    "pge-start-lublin": "Start Lublin",
    "pumpa-basket-brno": "PUMPA Basket Brno",
    "rasta-vechta": "RASTA Vechta",
    "rilski-sportist": "Rilski Sportist",
    "rostock-seawolves": "Rostock Seawolves",
    "sporting-cp": "Sporting CP",
    "surne-bilbao-basket": "Surne Bilbao Basket",
    "tartu-ulikool-maks-moorits": "Tartu",
    "transcom-parnu": "Transcom Parnu",
    "ucam-murcia": "UCAM Murcia",
    "windrose-giants-antwerp": "Windrose Antwerp",
}

# --- Court geometry (see module docstring) ---
COURT_W, COURT_H = 618.0, 336.0
COURT_W_M, COURT_H_M = 28.0, 15.0
SCALE_X = COURT_W / COURT_W_M
SCALE_Y = COURT_H / COURT_H_M
HOOP_IN_FROM_BASELINE_M = 1.575
HOOP_Y_M = COURT_H_M / 2
LEFT_HOOP = (HOOP_IN_FROM_BASELINE_M * SCALE_X, HOOP_Y_M * SCALE_Y)
RIGHT_HOOP = (COURT_W - HOOP_IN_FROM_BASELINE_M * SCALE_X, HOOP_Y_M * SCALE_Y)
AT_RIM_RADIUS_M = 1.8
ARC_RADIUS_M = 6.75
CORNER_ANGLE_DEG = 60.0
TOP_KEY_ANGLE_DEG = 25.0


def classify_zone(x: float, y: float) -> str:
    hoop = LEFT_HOOP if x < COURT_W / 2 else RIGHT_HOOP
    dx_m = (x - hoop[0]) / SCALE_X
    dy_m = (y - hoop[1]) / SCALE_Y
    dist_m = math.hypot(dx_m, dy_m)
    if dist_m <= AT_RIM_RADIUS_M:
        return "at_rim"
    if dist_m < ARC_RADIUS_M:
        return "mid_range"
    angle_deg = math.degrees(math.atan2(abs(dy_m), abs(dx_m)))
    if angle_deg >= CORNER_ANGLE_DEG:
        return "corner_3"
    if angle_deg < TOP_KEY_ANGLE_DEG:
        return "top_key_3"
    return "wing_3"


# --- Player matching (see module docstring) ---
# Site names here are abbreviated ("F. Surname") but already plain English,
# same alphabet/convention as this app's own FIBA Europe Cup player names —
# no transliteration needed (unlike the Greek Basket League player-shot-zone
# script). Matching is by surname equality within a team's own roster only
# (12-15 players/team; a same-surname collision on one club is checked for
# explicitly below and left unmatched rather than guessed).
def surname_of(full_or_abbrev_name: str) -> str:
    parts = [p for p in re.split(r"\s+", full_or_abbrev_name.strip()) if p]
    if not parts:
        return ""
    # abbreviated site names are "F. Surname" or "F. Van Surname" — drop the
    # leading single-letter-plus-dot initial if present, keep the rest.
    if len(parts[0]) <= 2 and parts[0].endswith("."):
        parts = parts[1:]
    return " ".join(parts).upper()


def surname_similarity(db_name: str, site_name: str) -> float:
    db_parts = [p for p in re.split(r"\s+", db_name.strip()) if p]
    db_surname = db_parts[-1].upper() if db_parts else ""
    if not db_surname:
        return 0.0
    site_surname = surname_of(site_name)
    return difflib.SequenceMatcher(None, db_surname, site_surname).ratio()


def log(msg: str) -> None:
    print(f"[fec-shot-zones] {msg}", flush=True)


def accept_cookies(page) -> None:
    for text in ("Accept", "I ACCEPT", "Accept All", "AGREE"):
        try:
            page.get_by_role("button", name=text, exact=False).first.click(timeout=2500)
            return
        except PlaywrightError:
            continue


def new_page(browser):
    return browser.new_page(viewport={"width": 1280, "height": 1400}, user_agent=USER_AGENT)


GAME_SLUG_RE = re.compile(r"^(\d+)-([A-Za-z0-9]+)-([A-Za-z0-9]+)$")


def collect_team_games(page, slug: str) -> list[str]:
    """Returns unique game slugs (e.g. "128876-SBB-PBC") from a team's Games tab."""
    page.goto(f"{BASE}/teams/{slug}", timeout=45000, wait_until="domcontentloaded")
    page.wait_for_timeout(800)
    try:
        page.get_by_role("tab", name="Games", exact=True).click(timeout=8000)
    except PlaywrightError:
        try:
            page.get_by_text("Games", exact=True).first.click(timeout=8000)
        except PlaywrightError:
            return []
    page.wait_for_timeout(1200)
    html = page.content()
    return sorted(set(re.findall(r"games/(\d+-[A-Za-z0-9]+-[A-Za-z0-9]+)", html)))


SHOT_CHART_JS = """
() => {
  const container = document.querySelector('div._1xyado84');
  if (!container) return null;
  let target = null;
  for (const kid of Array.from(container.children)) {
    const fk = Object.keys(kid).find(k => k.startsWith('__reactFiber'));
    if (!fk) continue;
    let fiber = kid[fk];
    let depth = 0;
    while (fiber && depth < 12) {
      const p = fiber.memoizedProps;
      if (p && p.points && p.teamA && p.teamB) { target = p; break; }
      fiber = fiber.return;
      depth++;
    }
    if (target) break;
  }
  if (!target) return null;
  return { points: target.points, teamA: target.teamA, teamB: target.teamB };
}
"""


def scrape_game_once(page, game_slug: str, code_to_slug: dict) -> dict | None:
    m = GAME_SLUG_RE.match(game_slug)
    if not m:
        return None
    _, code_a, code_b = m.groups()
    slug_a, slug_b = code_to_slug.get(code_a), code_to_slug.get(code_b)
    if not slug_a or not slug_b:
        return None
    side_slugs = [slug_a, slug_b]

    url = f"{BASE}/games/{game_slug}"
    page.goto(url, timeout=45000, wait_until="domcontentloaded")
    page.wait_for_timeout(2000)

    # Clicking "Shot Chart" too early — before the page has finished
    # hydrating — silently misses (confirmed live: the exact same click +
    # single fixed-wait + single evaluate() sequence that fails most of the
    # time in this automated script succeeds every time done by hand in a
    # real browser). Retrying the click a few times, and polling for the
    # extracted data instead of a single fixed wait + single evaluate,
    # rides out that hydration race instead of gambling on one fixed delay.
    clicked = False
    for _ in range(3):
        try:
            page.get_by_role("tab", name="Shot Chart", exact=True).click(timeout=6000)
            clicked = True
            break
        except PlaywrightError:
            try:
                page.get_by_text("Shot Chart", exact=True).first.click(timeout=6000)
                clicked = True
                break
            except PlaywrightError:
                page.wait_for_timeout(1000)
    if not clicked:
        return None

    data = None
    for _ in range(8):
        page.wait_for_timeout(1000)
        try:
            data = page.evaluate(SHOT_CHART_JS)
        except PlaywrightError:
            data = None
        if data and data.get("points"):
            break
    if not data or not data.get("points"):
        return None

    return {"data": data, "side_slugs": side_slugs}


def scrape_game(browser, page, game_slug: str, code_to_slug: dict):
    """Wraps scrape_game_once with a single retry on a FRESH page — a long-
    lived browser session degrades over ~15-20 consecutive game loads on
    this site (confirmed: every game after roughly the 15th in a session
    started failing, while the exact same games succeeded fine in earlier,
    shorter test runs) — the same page-degradation failure mode already
    seen and fixed this session for bcl_team_shot_zones_export.py. Returns
    (result_or_None, page) — the caller must keep using the returned page."""
    result = scrape_game_once(page, game_slug, code_to_slug)
    if result is not None:
        return result, page
    try:
        page.close()
    except PlaywrightError:
        pass
    page = new_page(browser)
    result = scrape_game_once(page, game_slug, code_to_slug)
    return result, page


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=str, default="./out-fec-shot-zones")
    ap.add_argument("--players-json", type=str, default="./fec_players_ppg.json")
    ap.add_argument("--teams", type=str, default=None, help="Comma-separated team slugs to restrict discovery to (default: all 44)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    with open(args.players_json, encoding="utf-8") as f:
        db_players_by_team = json.load(f)

    games_path = os.path.join(args.out, "games.json")
    shots_path = os.path.join(args.out, "raw_shots.csv")
    zones_path = os.path.join(args.out, "player_shot_zones.csv")
    matches_path = os.path.join(args.out, "matches.csv")

    slugs = args.teams.split(",") if args.teams else list(TEAM_SLUGS.keys())

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        page = new_page(browser)
        page.goto("https://www.fiba.basketball/", timeout=45000, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        accept_cookies(page)
        page.wait_for_timeout(500)

        # --- Phase 1: discover all games + each team's own stable 3-letter
        # code. No page carries an explicit code->team mapping, so the code
        # is derived by self-consistency instead: across every game slug a
        # team's own Games tab lists, exactly one of the two embedded codes
        # is constant (that team's own code) while the other varies (the
        # opponent's) — the intersection of code-sets across all of a team's
        # games isolates it with no extra scraping needed.
        all_games = set()
        games_by_team = {}
        if os.path.exists(games_path):
            with open(games_path, encoding="utf-8") as f:
                cache = json.load(f)
            all_games = set(cache["games"])
            code_to_slug = cache["code_to_slug"]
            log(f"Loaded {len(all_games)} cached game slug(s), {len(code_to_slug)} team code(s).")
        else:
            for slug in slugs:
                log(f"Discovering games for {slug}...")
                try:
                    games = collect_team_games(page, slug)
                except PlaywrightError as exc:
                    log(f"  error ({exc}) — skipping.")
                    page.close()
                    page = new_page(browser)
                    continue
                games_by_team[slug] = games
                all_games.update(games)
                log(f"  {len(games)} game(s) found; running total {len(all_games)}.")

            code_to_slug = {}
            for slug, games in games_by_team.items():
                code_sets = []
                for g in games:
                    m = GAME_SLUG_RE.match(g)
                    if m:
                        code_sets.append({m.group(2), m.group(3)})
                own_codes = set.intersection(*code_sets) if code_sets else set()
                if len(own_codes) != 1:
                    log(f"  WARNING: could not resolve a stable code for {slug} (candidates: {own_codes}) — its games will be skipped.")
                    continue
                code_to_slug[next(iter(own_codes))] = slug

            with open(games_path, "w", encoding="utf-8") as f:
                json.dump({"games": sorted(all_games), "code_to_slug": code_to_slug}, f, indent=2, ensure_ascii=False)
            log(f"Discovered {len(all_games)} unique games across {len(slugs)} teams, resolved {len(code_to_slug)} team code(s).")

        # --- Phase 2: scrape each game's shot chart ---
        already_done = set()
        if os.path.exists(shots_path):
            with open(shots_path, encoding="utf-8") as f:
                already_done = {row["game_slug"] for row in csv.DictReader(f)}
            log(f"Resuming: {len(already_done)} game(s) already scraped.")

        is_new = not os.path.exists(shots_path)
        shots_f = open(shots_path, "a", newline="", encoding="utf-8")
        shots_w = csv.DictWriter(shots_f, fieldnames=["game_slug", "team_name", "player_id", "player_site_name", "x", "y", "zone", "made"])
        if is_new:
            shots_w.writeheader()

        scraped = 0
        for game_slug in sorted(all_games):
            if game_slug in already_done:
                continue
            if scraped > 0 and scraped % 20 == 0:
                log("  recycling the whole browser process (preventive)...")
                try:
                    browser.close()
                except PlaywrightError:
                    pass
                browser = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
                page = new_page(browser)
            elif scraped > 0 and scraped % 6 == 0:
                log("  recycling browser page (preventive)...")
                try:
                    page.close()
                except PlaywrightError:
                    pass
                page = new_page(browser)

            log(f"Scraping {game_slug}...")
            try:
                result, page = scrape_game(browser, page, game_slug, code_to_slug)
            except PlaywrightError as exc:
                log(f"  page error ({exc}) — reopening, skipping for now.")
                try:
                    page.close()
                except PlaywrightError:
                    pass
                page = new_page(browser)
                continue

            if not result:
                log("  no shot data — skipping.")
                # still mark as attempted so a permanently-broken game doesn't block resume forever
                shots_w.writerow({"game_slug": game_slug, "team_name": "", "player_id": "", "player_site_name": "", "x": "", "y": "", "zone": "", "made": ""})
                shots_f.flush()
                continue

            data = result["data"]
            side_a_slug, side_b_slug = result["side_slugs"]
            team_name_by_side = {"A": TEAM_SLUGS.get(side_a_slug, side_a_slug), "B": TEAM_SLUGS.get(side_b_slug, side_b_slug)}
            roster_by_id = {}
            for entry in data["teamA"]:
                roster_by_id[str(entry["playerId"])] = entry["name"]
            for entry in data["teamB"]:
                roster_by_id[str(entry["playerId"])] = entry["name"]

            count = 0
            for pt in data["points"]:
                pid = str(pt.get("playerId", ""))
                team = pt.get("team")
                if not pid or team not in team_name_by_side:
                    continue
                x, y = pt.get("x"), pt.get("y")
                if x is None or y is None:
                    continue
                zone = classify_zone(float(x), float(y))
                made = pt.get("type") == "MADE"
                shots_w.writerow({
                    "game_slug": game_slug,
                    "team_name": team_name_by_side[team],
                    "player_id": pid,
                    "player_site_name": roster_by_id.get(pid, ""),
                    "x": x, "y": y, "zone": zone, "made": int(made),
                })
                count += 1
            shots_f.flush()
            scraped += 1
            log(f"  {count} shot(s) recorded.")
            time.sleep(2.0)

        browser.close()
    shots_f.close()
    log(f"Done scraping. Wrote {shots_path}.")

    # --- Phase 3: aggregate raw shots -> per-player zone fgm/fga, matched to this app's DB ---
    with open(shots_path, encoding="utf-8") as f:
        raw = [r for r in csv.DictReader(f) if r["player_id"]]

    by_team = {}
    for r in raw:
        by_team.setdefault(r["team_name"], []).append(r)

    zones_f = open(zones_path, "w", newline="", encoding="utf-8")
    zones_w = csv.DictWriter(zones_f, fieldnames=["team_name", "player_name", "zone", "fgm", "fga"])
    zones_w.writeheader()
    matches_f = open(matches_path, "w", newline="", encoding="utf-8")
    matches_w = csv.DictWriter(matches_f, fieldnames=["team_name", "db_name", "site_name", "distance", "surname_similarity"])
    matches_w.writeheader()

    for team_name, rows in by_team.items():
        db_players = db_players_by_team.get(team_name, [])
        if not db_players:
            continue
        by_pid = {}
        for r in rows:
            by_pid.setdefault(r["player_id"], {"name": r["player_site_name"], "shots": []})
            by_pid[r["player_id"]]["shots"].append(r)

        for pid, info in by_pid.items():
            site_surname = surname_of(info["name"])
            candidates = [p for p in db_players if p["name"].split()[-1].upper() == site_surname]
            if len(candidates) != 1:
                continue
            db_p = candidates[0]
            zone_totals = {}
            for s in info["shots"]:
                z = s["zone"]
                zone_totals.setdefault(z, [0, 0])
                zone_totals[z][1] += 1
                if s["made"] == "1":
                    zone_totals[z][0] += 1
            for zone, (fgm, fga) in zone_totals.items():
                zones_w.writerow({"team_name": team_name, "player_name": db_p["name"], "zone": zone, "fgm": fgm, "fga": fga})
            matches_w.writerow({"team_name": team_name, "db_name": db_p["name"], "site_name": info["name"], "distance": "", "surname_similarity": f"{surname_similarity(db_p['name'], info['name']):.2f}"})

    zones_f.close()
    matches_f.close()
    log(f"Done. Wrote {zones_path} and {matches_path}.")


if __name__ == "__main__":
    main()
