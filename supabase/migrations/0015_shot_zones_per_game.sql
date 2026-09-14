-- ============================================================================
-- Box Score Analytics — ties shot_zones rows to a specific game
--
-- Manual shot-chart entry (new: a half-court click UI, one zone/player/team
-- at a time) needs to know WHICH match each entry belongs to, so a coach can
-- enter a handful of players' zone data per game and later see both the
-- per-player breakdown and a real team total (summed across every entry for
-- that game, and across every game in the season). The existing shot_zones
-- table only had team_id/player_id/season_id — enough for the old bulk
-- "import a whole season's zone data at once" flow, but not for building up
-- a season total incrementally from many small per-game entries.
--
-- Nullable: historical shot_zones rows (from the local-SQLite backfill, and
-- any future bulk season-level import) have no single game to point at —
-- they stay valid, season-level-only rows. Reading code was already summing
-- across every matching row per zone (buildZoneChart), so mixing game-scoped
-- and season-only rows in the same season total is already correct with no
-- other change needed.
-- ============================================================================

alter table public.shot_zones
  add column if not exists game_id bigint references public.games (id) on delete cascade;

create index if not exists shot_zones_game_id_idx on public.shot_zones (game_id);
