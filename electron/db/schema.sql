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
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  date TEXT NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  source TEXT NOT NULL DEFAULT 'photo'   -- 'photo' | 'public_api'
);

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
  plus_minus INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_box_scores_player ON box_scores(player_id);
CREATE INDEX IF NOT EXISTS idx_box_scores_game ON box_scores(game_id);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league_id);
