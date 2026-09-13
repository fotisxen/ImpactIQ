"""
Pulls REAL per-zone shooting data for individual Basketball Champions League
players from 3stepsbasket.com's player shot chart pages — same source,
technique, and 11-zone template as bcl_team_shot_zones_export.py (team-level)
and esake_player_shot_zones_export.py (the GBL sibling this file was copied
from — see that file's docstring for the full matching-safety discovery
notes, unchanged here).

The hard part for player-level data isn't the shot chart itself (identical
technique to team-level) — it's matching a 3stepsbasket player (English name,
e.g. "Amine Noua") to the right row in this app's own `players` table (Greek
transliterated names scraped from esake.gr's own box scores, e.g.
"ΝΟΥA AΜΙΝ", no jersey number stored). This uses TWO independent, mandatory
checks, both of which must pass — one alone isn't safe enough, confirmed by a
real failure caught mid-session:
  1. A season stat "fingerprint" (points/assists/rebounds/turnovers/steals
     per game) — the closest candidate must be clearly closer than the
     runner-up (see match_players).
  2. A rough Greek->Latin transliteration of the db player's surname,
     fuzzy-compared against the site's surname (see surname_similarity) —
     this is what catches the failure mode stat-distance alone missed: on a
     roster full of low-minute bench players whose per-game stats cluster
     near zero, two DIFFERENT real players (confirmed live: "ΝΕΤΖΗΠΟΓΛΟΥ
     ΟΜΗΡΟΣ" / Omiros Netzipoglou vs "ΛΑΡΕΝΤΖΑΚΗΣ ΓΙΑΝΝΟΥΛΗΣ" / Giannoulis
     Larentzakis, both real Olympiacos players) can have close-enough stat
     lines that a pure distance metric picks the wrong one — but their
     surnames obviously don't correspond at all, which the transliteration
     check catches even with an intentionally rough, imperfect table.
Anything that fails either check is skipped and reported in unmatched.csv,
never guessed.

Requires data-import/bcl_players_ppg.json (this app's own player_id/name/ppg
per team, exported from the live SQLite DB via _scratch_export_bcl_players.js).

Setup:
    pip install playwright
    python -m playwright install chromium   (skip if already installed)

Usage:
    python bcl_player_shot_zones_export.py --out ./out-bcl-player-shot-zones
"""

import argparse
import csv
import difflib
import json
import os
import re
import time

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError

# Deliberately rough Greek->Latin transliteration (not a full ELOT 743
# implementation) — good enough to make a real name-pair's surnames land
# close together as plain ASCII strings, which is all the safety check below
# needs. Multi-letter digraphs must be matched before their single-letter
# components (dict iteration order below preserves this).
GREEK_DIGRAPHS = [
    ("ΜΠ", "B"), ("ΝΤ", "D"), ("ΓΚ", "G"), ("ΤΣ", "TS"), ("ΤΖ", "TZ"), ("ΓΓ", "NG"), ("ΓΞ", "NX"), ("ΟΥ", "OU"),
    ("ΑΙ", "E"), ("ΕΙ", "I"), ("ΟΙ", "I"), ("ΥΙ", "I"), ("ΑΥ", "AV"), ("ΕΥ", "EV"),
]
GREEK_LETTERS = {
    "Α": "A", "Ά": "A", "Β": "V", "Γ": "G", "Δ": "D", "Ε": "E", "Έ": "E", "Ζ": "Z", "Η": "I", "Ή": "I",
    "Θ": "TH", "Ι": "I", "Ί": "I", "Ϊ": "I", "Κ": "K", "Λ": "L", "Μ": "M", "Ν": "N", "Ξ": "X", "Ο": "O",
    "Ό": "O", "Π": "P", "Ρ": "R", "Σ": "S", "Τ": "T", "Υ": "Y", "Ύ": "Y", "Φ": "F", "Χ": "H", "Ψ": "PS", "Ω": "O", "Ώ": "O",
}


def transliterate(text: str) -> str:
    text = text.upper()
    for gr, la in GREEK_DIGRAPHS:
        text = text.replace(gr, la)
    out = []
    for ch in text:
        out.append(GREEK_LETTERS.get(ch, ch))
    return "".join(out)


def surname_similarity(db_name: str, site_name: str) -> float:
    """db_name is "SURNAME FIRSTNAME[...]" (this app's convention, from
    esake.gr's own box scores); site_name is "Firstname Surname" (or
    multi-word variants on either side). Rather than guess which word is the
    surname on the site side, compare the transliterated db surname against
    every word of the site name and keep the best ratio — cheap, and robust
    to either name having a multi-word surname or firstname."""
    db_surname = transliterate(db_name.split()[0]) if db_name.split() else ""
    if not db_surname:
        return 0.0
    site_words = [w for w in re.split(r"[\s\-]+", site_name) if w]
    best = 0.0
    for w in site_words:
        ratio = difflib.SequenceMatcher(None, db_surname, w.upper()).ratio()
        best = max(best, ratio)
    return best


MIN_SURNAME_SIMILARITY = 0.6

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

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
# Roster link text looks like:
#   "#5 Amine Noua    6'7'' / 2.03 | 29 | F  18.3 pts, 1 ast, 6.7 reb, 1.2 tov, 1.1 stl"
ROSTER_LINK_RE = re.compile(
    r"^#(\d+)\s+(.+?)\s{2,}.*?\|\s*[A-Z]\s+"
    r"([\d.]+)\s*pts,\s*([\d.]+)\s*ast,\s*([\d.]+)\s*reb,\s*([\d.]+)\s*tov,\s*([\d.]+)\s*stl",
    re.DOTALL,
)

# Multi-stat fingerprint match: a single-stat (PPG-only) comparison isn't
# discriminating enough for heavy-rotation clubs — confirmed live on
# Olympiacos, whose bench-vs-starter minutes swing so much game-to-game that
# PPG alone left 12 of 19 players (including a full-time starter, Vezenkov)
# unmatched even though every one of them has a real, correct counterpart in
# our own DB. Comparing points+assists+rebounds+turnovers+steals as one
# vector is far harder for two different players to coincidentally satisfy
# at once, so it resolves those cases correctly instead of just widening a
# single tolerance (which would risk wrong matches, not just missed ones).
STATS = ("ppg", "apg", "rpg", "tpg", "spg")
MAX_DIST = 3.0  # combined Euclidean distance across all 5 stats
MIN_GAP_TO_SECOND = 0.5


def log(msg: str) -> None:
    print(f"[esake-player-shot-zones] {msg}", flush=True)


def accept_cookies(page) -> None:
    try:
        page.get_by_role("button", name="Accept", exact=True).first.click(timeout=4000)
    except PlaywrightTimeoutError:
        pass


def new_page(browser):
    return browser.new_page(viewport={"width": 1280, "height": 1400}, user_agent=USER_AGENT)


def collect_roster(page, slug: str) -> list[dict]:
    """Returns [{jersey, name, ppg, apg, rpg, tpg, spg, href}] for a team's
    real GBL 2025-26 roster."""
    url = f"https://3stepsbasket.com/club/{slug}?season={SEASON_SLUG}"
    page.goto(url, timeout=45000, wait_until="domcontentloaded")
    page.wait_for_timeout(1200)
    raw = page.eval_on_selector_all(
        "a[href*='/player/']",
        "els => els.map(e => ({ href: e.getAttribute('href'), text: e.textContent }))",
    )
    out = []
    seen = set()
    for r in raw:
        href = r["href"]
        if href in seen:
            continue
        seen.add(href)
        m = ROSTER_LINK_RE.match(r["text"].strip())
        if not m:
            continue
        jersey, name = m.group(1), m.group(2).strip()
        ppg, apg, rpg, tpg, spg = (float(m.group(i)) for i in range(3, 8))
        out.append({"jersey": jersey, "name": name, "ppg": ppg, "apg": apg, "rpg": rpg, "tpg": tpg, "spg": spg, "href": href})
    return out


def stat_distance(entry: dict, p: dict) -> float:
    return sum((entry[s] - p[s]) ** 2 for s in STATS) ** 0.5


def match_players(roster: list[dict], db_players: list[dict]) -> list[dict]:
    """Matches 3stepsbasket roster entries to db_players by nearest 5-stat
    fingerprint (points/assists/rebounds/turnovers/steals per game),
    globally: every (entry, candidate) pair is scored up front and claimed in
    ascending order of distance, so the single best match on the whole
    roster is locked in first — resolving in roster-listing order instead
    would let an early, weaker match steal a db_player that actually belongs
    to a later, closer entry. A dedup on (entry href) also guards against
    3stepsbasket listing the same player twice (e.g. a "Best players"
    highlight card plus the full roster row) — confirmed to happen on a real
    roster page. See module docstring for why a stat fingerprint (not name
    transliteration) is the matching key."""
    seen_href = set()
    dedup_roster = []
    for entry in roster:
        if entry["href"] in seen_href:
            continue
        seen_href.add(entry["href"])
        dedup_roster.append(entry)

    all_pairs = []
    for entry in dedup_roster:
        for p in db_players:
            dist = stat_distance(entry, p)
            if dist > MAX_DIST:
                continue
            # Mandatory second gate — see module docstring for the real
            # wrong-match this catches (two different bench players with
            # coincidentally close stat lines). A pair failing this can
            # never be claimed, so a name-mismatched candidate can't "steal"
            # a db_player away from its real, correct site entry either.
            if surname_similarity(p["name"], entry["name"]) < MIN_SURNAME_SIMILARITY:
                continue
            all_pairs.append((dist, entry, p))
    all_pairs.sort(key=lambda x: x[0])

    used_entries = set()
    used_db_ids = set()
    claimed: dict[str, tuple] = {}  # entry href -> (diff, db_player)
    for diff, entry, p in all_pairs:
        href = entry["href"]
        if href in used_entries or p["id"] in used_db_ids:
            continue
        used_entries.add(href)
        used_db_ids.add(p["id"])
        claimed[href] = (diff, p)

    matches = []
    unmatched = []
    for entry in dedup_roster:
        href = entry["href"]
        if href not in claimed:
            unmatched.append(entry)
            continue
        diff, best = claimed[href]
        # Still enforce the "clearly better than the runner-up" guard, using
        # whichever candidates were still free at the moment this pair was claimed.
        others = sorted(d for d, e, pp in all_pairs if e["href"] == href and pp["id"] != best["id"])
        second_diff = others[0] if others else 999.0
        if (second_diff - diff) >= MIN_GAP_TO_SECOND:
            sim = surname_similarity(best["name"], entry["name"])
            matches.append({"href": href, "site_name": entry["name"], "db_id": best["id"], "db_name": best["name"], "diff": diff, "sim": sim})
        else:
            unmatched.append(entry)
    return matches, unmatched


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
            continue
        fgm, fga = int(m.group(1)), int(m.group(2))
        totals[zone][0] += fgm
        totals[zone][1] += fga
        zones_resolved += 1

    total_fga = sum(v[1] for v in totals.values())
    if zones_resolved == 0 or total_fga == 0:
        return None
    return {z: (v[0], v[1]) for z, v in totals.items()}


def scrape_shot_chart(browser, url: str, page):
    result = scrape_shot_chart_once(page, url)
    if result is not None:
        return result, page
    try:
        page.close()
    except PlaywrightError:
        pass
    page = new_page(browser)
    result = scrape_shot_chart_once(page, url)
    return result, page


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=str, default="./out-bcl-player-shot-zones", help="Output folder for CSVs")
    ap.add_argument("--teams", type=str, default=None, help="Comma-separated team slugs to restrict to (default: all 32)")
    ap.add_argument("--players-json", type=str, default="./bcl_players_ppg.json")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    with open(args.players_json, encoding="utf-8") as f:
        db_players_by_team = json.load(f)

    slugs = args.teams.split(",") if args.teams else list(TEAM_SLUGS.keys())
    out_path = os.path.join(args.out, "player_shot_zones.csv")
    unmatched_path = os.path.join(args.out, "unmatched.csv")
    matchlog_path = os.path.join(args.out, "matches.csv")
    fieldnames = ["team_name", "player_name", "zone", "fgm", "fga"]

    already_done = set()
    if os.path.exists(out_path):
        with open(out_path, encoding="utf-8") as f:
            already_done = {(row["team_name"], row["player_name"]) for row in csv.DictReader(f)}
        if already_done:
            log(f"Resuming: {len(already_done)} player(s) already in {out_path}, will be skipped.")

    is_new = not os.path.exists(out_path)
    out_f = open(out_path, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(out_f, fieldnames=fieldnames)
    if is_new:
        writer.writeheader()
    unmatched_f = open(unmatched_path, "a", newline="", encoding="utf-8")
    unmatched_w = csv.DictWriter(unmatched_f, fieldnames=["team_name", "site_name", "site_ppg"])
    if not os.path.exists(unmatched_path) or os.path.getsize(unmatched_path) == 0:
        unmatched_w.writeheader()
    # Auditability: every accepted match's (db_name, site_name, distance,
    # surname_similarity) — so a real wrong-match like the Netzipoglou case
    # can be spot-checked later without needing to re-scrape.
    matchlog_f = open(matchlog_path, "a", newline="", encoding="utf-8")
    matchlog_w = csv.DictWriter(matchlog_f, fieldnames=["team_name", "db_name", "site_name", "distance", "surname_similarity"])
    if not os.path.exists(matchlog_path) or os.path.getsize(matchlog_path) == 0:
        matchlog_w.writeheader()

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
            db_players = db_players_by_team.get(team_name, [])
            if not db_players:
                log(f"No db players found for team '{team_name}' — skipping team.")
                continue

            log(f"Fetching roster for {team_name}...")
            roster = collect_roster(page, slug)
            matches, unmatched = match_players(roster, db_players)
            log(f"  {team_name}: {len(matches)} matched, {len(unmatched)} unmatched.")
            for u in unmatched:
                unmatched_w.writerow({"team_name": team_name, "site_name": u["name"], "site_ppg": u["ppg"]})
            unmatched_f.flush()

            for m in matches:
                if (team_name, m["db_name"]) in already_done:
                    continue

                if scraped_count > 0 and scraped_count % 8 == 0:
                    log("  recycling the browser page (preventive)...")
                    try:
                        page.close()
                    except PlaywrightError:
                        pass
                    page = new_page(browser)

                # href from roster is "/player/{slug}?season=gbl26" (relative — eval_on_selector_all
                # returns the raw attribute, not the resolved absolute URL) — shooting page is
                # "/player/{slug}/shooting?season=gbl26".
                href_path = m["href"] if m["href"].startswith("http") else "https://3stepsbasket.com" + m["href"]
                shooting_url = href_path.split("?")[0] + "/shooting?season=" + SEASON_SLUG

                log(f"  Scraping {m['db_name']} ({m['site_name']}, diff={m['diff']:.2f})...")
                try:
                    zones, page = scrape_shot_chart(browser, shooting_url, page)
                except PlaywrightError as exc:
                    log(f"    page error ({exc}) — reopening page, skipping this player for now.")
                    try:
                        page.close()
                    except PlaywrightError:
                        pass
                    page = new_page(browser)
                    continue

                if not zones:
                    log("    no valid chart data — skipping.")
                    continue
                scraped_count += 1

                for zone, (fgm, fga) in zones.items():
                    writer.writerow({"team_name": team_name, "player_name": m["db_name"], "zone": zone, "fgm": fgm, "fga": fga})
                out_f.flush()
                matchlog_w.writerow({"team_name": team_name, "db_name": m["db_name"], "site_name": m["site_name"], "distance": f"{m['diff']:.3f}", "surname_similarity": f"{m['sim']:.2f}"})
                matchlog_f.flush()
                total_fga = sum(v[1] for v in zones.values())
                log(f"    {total_fga} total FGA across 5 zones.")
                time.sleep(0.4)

        browser.close()

    out_f.close()
    unmatched_f.close()
    matchlog_f.close()
    log(f"Done. Wrote {out_path}, {unmatched_path}, and {matchlog_path}")


if __name__ == "__main__":
    main()
