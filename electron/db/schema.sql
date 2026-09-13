-- Auth (email/password, sessions) now lives in Supabase — see
-- supabase/migrations/. The local `users` table is gone; everything below
-- is still local SQLite until the box-score domain itself moves to
-- Supabase too (see supabase/migrations/0002_box_score_domain.sql).

CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT,
  tier TEXT,               -- e.g. 'euroleague', 'greek_gbl', 'custom'
  source TEXT NOT NULL DEFAULT 'manual'  -- 'manual' | 'public_api'
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id),
  year TEXT NOT NULL        -- e.g. '2025-26'
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id),
  name TEXT NOT NULL,
  is_my_team INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  position TEXT,  -- 'PG' | 'SG' | 'SF' | 'PF' | 'C', optional/manual — nobody tracks this automatically
  depth_rank INTEGER,  -- manual depth-chart order within `position`, lower = higher on the chart. Optional.
  height TEXT,    -- free text (e.g. 6'2" or 188cm), optional/manual — no source captures this
  hidden INTEGER NOT NULL DEFAULT 0  -- excluded from depth chart / leaders / player pages in Scouting (e.g. a young player who never plays) — team-level totals still include their real games
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  date TEXT NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  source TEXT NOT NULL DEFAULT 'photo',   -- 'photo' | 'manual' | 'public_api'
  pending_sync INTEGER NOT NULL DEFAULT 0,  -- 1 while a cloud push (see services/dataSync.js) is still owed/failed
  synced_at TEXT
);

-- Bridges this install's local autoincrement ids to the matching Supabase
-- row ids for entities pushed to the cloud (see services/dataSync.js) — the
-- two id spaces are independent, so a natural-key lookup-or-create can't
-- just reuse the local id as the remote one.
CREATE TABLE IF NOT EXISTS sync_map (
  entity_type TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  remote_id TEXT NOT NULL,
  PRIMARY KEY (entity_type, local_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_map_remote ON sync_map(entity_type, remote_id);

CREATE TABLE IF NOT EXISTS box_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  min REAL NOT NULL DEFAULT 0,
  pts INTEGER NOT NULL DEFAULT 0,
  fgm INTEGER NOT NULL DEFAULT 0,
  fga INTEGER NOT NULL DEFAULT 0,
  tpm INTEGER NOT NULL DEFAULT 0,
  tpa INTEGER NOT NULL DEFAULT 0,
  ftm INTEGER NOT NULL DEFAULT 0,
  fta INTEGER NOT NULL DEFAULT 0,
  oreb INTEGER NOT NULL DEFAULT 0,
  dreb INTEGER NOT NULL DEFAULT 0,
  ast INTEGER NOT NULL DEFAULT 0,
  stl INTEGER NOT NULL DEFAULT 0,
  blk INTEGER NOT NULL DEFAULT 0,
  tov INTEGER NOT NULL DEFAULT 0,
  pf INTEGER NOT NULL DEFAULT 0,
  pfd INTEGER NOT NULL DEFAULT 0,
  plus_minus INTEGER NOT NULL DEFAULT 0,
  srj INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_box_scores_player ON box_scores(player_id);
CREATE INDEX IF NOT EXISTS idx_box_scores_game ON box_scores(game_id);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league_id);

-- Caches OCR results by image hash so re-uploading the exact same photo
-- (e.g. retrying after an app-side bug, not an OCR problem) never re-bills
-- the Claude API for a call we've already paid for.
CREATE TABLE IF NOT EXISTS ocr_cache (
  image_hash TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Raw substitution/scoring timeline from a play-by-play import — only
-- populated for games imported that way (photo/manual entries have no
-- events). Deliberately the minimal primitives (who's on court, when the
-- score changed) rather than a precomputed "lineup stints" shape, since
-- that's derivable from these on demand and we don't yet know exactly what
-- shape a future on/off or RAPM calculation will want.
CREATE TABLE IF NOT EXISTS game_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_id INTEGER REFERENCES players(id),
  clock_seconds INTEGER NOT NULL,
  event_type TEXT NOT NULL,   -- 'sub_in' | 'sub_out' | 'score' | 'miss' | 'assist' | 'turnover_live' | 'turnover_dead' | 'reb_off' | 'reb_def'
  points INTEGER,             -- for 'score'/'miss' events: 2, 3, or 1 (the shot's value, made or not)
  sequence INTEGER NOT NULL   -- preserves original event order for same-timestamp events
);

CREATE INDEX IF NOT EXISTS idx_game_events_game ON game_events(game_id);

-- Shot-location zone data. Not derivable from anything else the app collects
-- (no input method captures shot coordinates) — populated only via an
-- explicit import (db:import-shot-zones), from wherever the user sources it
-- (e.g. the EuroLeague API's own shot-data endpoint). A NULL player_id row is
-- that team's own zone total, not any one player's.
CREATE TABLE IF NOT EXISTS shot_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_id INTEGER REFERENCES players(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  zone TEXT NOT NULL CHECK(zone IN ('at_rim', 'mid_range', 'corner_3', 'wing_3', 'top_key_3')),
  fgm INTEGER NOT NULL,
  fga INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shot_zones_team_season ON shot_zones(team_id, season_id);
CREATE INDEX IF NOT EXISTS idx_shot_zones_player_season ON shot_zones(player_id, season_id);

-- Individual shot locations (one row per attempt), for a real dot-scatter
-- shot chart on an actual half-court — not just zone aggregates. x/y are
-- already in the app's own half-court coordinate space (0-300 wide, 0-320
-- deep, basket at 150,20 — the same convention the Draw tool's court uses)
-- so the frontend plots them directly with no per-source transform logic.
-- Populated the same way shot_zones is (an explicit import) — a source that
-- doesn't provide real coordinates just never inserts rows here.
CREATE TABLE IF NOT EXISTS shot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_id INTEGER REFERENCES players(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  x REAL NOT NULL,
  y REAL NOT NULL,
  made INTEGER NOT NULL,
  value INTEGER NOT NULL -- 2 or 3, the shot's point value if made
);

CREATE INDEX IF NOT EXISTS idx_shot_events_team_season ON shot_events(team_id, season_id);
CREATE INDEX IF NOT EXISTS idx_shot_events_player_season ON shot_events(player_id, season_id);

-- Official per-team, per-game "extra" stats (Points off Turnovers, Second
-- Chance Points, Fastbreak Points, Points in the Paint) sourced directly from
-- a real data provider's own shot-level flags (e.g. EuroLeague's shot-data
-- API tags each shot FASTBREAK/SECOND_CHANCE/POINTS_OFF_TURNOVER, and "in the
-- paint" is derived from shot zone). When a row exists here for a game, it's
-- preferred over the app's own possession-reconstruction estimate (see
-- services/possessions.js), since it's the source's own ground truth rather
-- than a clock-threshold heuristic.
CREATE TABLE IF NOT EXISTS team_game_advanced_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  points_off_turnovers INTEGER NOT NULL,
  second_chance_points INTEGER NOT NULL,
  fastbreak_points INTEGER NOT NULL,
  points_in_the_paint INTEGER NOT NULL,
  UNIQUE(game_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_team_game_advanced_stats_team ON team_game_advanced_stats(team_id);

-- One saved, editable scouting report per (our team, opponent, upcoming game).
CREATE TABLE IF NOT EXISTS scouting_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  our_team_id INTEGER NOT NULL REFERENCES teams(id),
  opponent_team_id INTEGER NOT NULL REFERENCES teams(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  game_date TEXT NOT NULL,
  keys_to_game TEXT NOT NULL DEFAULT '[]'  -- JSON array of coach-written bullet strings
);

CREATE INDEX IF NOT EXISTS idx_scouting_reports_teams ON scouting_reports(our_team_id, opponent_team_id, season_id);

-- Per-player coach notes ("how to guard them") within one scouting report, plus an optional photo.
CREATE TABLE IF NOT EXISTS scouting_report_player_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES scouting_reports(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  notes TEXT NOT NULL DEFAULT '[]',  -- JSON array of bullet strings
  photo_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_scouting_report_player_notes_report ON scouting_report_player_notes(report_id);

-- A saved play diagram: one or more court "frames" (a sequence showing the
-- play develop, frame by frame), each frame holding player/ball positions
-- plus drawn movement/pass/screen/dribble lines. The whole frame sequence is
-- one JSON blob (`data`) since its shape is inherently freeform/vector, not
-- relational. team_id is nullable so a play can be saved before a team is
-- picked, but the Draw screen scopes the playbook list by team once set.
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER REFERENCES teams(id),
  name TEXT NOT NULL,
  data TEXT NOT NULL,  -- JSON: { frames: PlayFrame[] }
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plays_team ON plays(team_id);
