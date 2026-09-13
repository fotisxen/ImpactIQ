-- ============================================================================
-- Box Score Analytics — full data model migration (Supabase becomes the
-- only data store; local SQLite is being retired entirely per the owner's
-- decision to go fully cloud-backed for production).
--
-- Adds every table that only ever existed in local SQLite
-- (electron/db/schema.sql) until now: game_events, shot_zones, shot_events,
-- team_game_advanced_stats, scouting_reports, scouting_report_player_notes,
-- plays, ocr_cache. Also patches `players` (missing 4 columns the
-- depth-chart/scouting features need) and drops the now-meaningless local
-- <-> remote sync-bridge leftovers (sync_map, games.pending_sync/synced_at)
-- now that there's only one store to have data in.
--
-- RLS pattern (reused verbatim from 0010_annual_tier_restructure.sql's
-- games/box_scores policies — see that file's comments for the full
-- rationale): every owner/org-scoped table gets two permissive SELECT
-- policies (own org on manual/photo tier, OR the platform-feed org while
-- the caller's own org is on pro tier), owner-scoped INSERT/UPDATE gated
-- by the caller's own org being on manual/photo tier, and owner-scoped
-- DELETE. Child tables with no owner/org column of their own derive
-- visibility/write access via their parent row, exactly like box_scores
-- already does against games.
-- ============================================================================

-- 1. players: add the columns local SQLite already had ---------------------

alter table public.players add column if not exists position text;
alter table public.players add column if not exists depth_rank integer;
alter table public.players add column if not exists height text;
alter table public.players add column if not exists hidden boolean not null default false;

-- 2. game_events — child of games, same shape as box_scores ----------------

create table public.game_events (
  id bigint generated always as identity primary key,
  game_id bigint not null references public.games (id) on delete cascade,
  team_id bigint not null references public.teams (id),
  player_id bigint references public.players (id),
  clock_seconds integer not null,
  event_type text not null, -- 'sub_in'|'sub_out'|'score'|'miss'|'assist'|'turnover_live'|'turnover_dead'|'reb_off'|'reb_def'
  points integer,
  sequence integer not null
);

create index game_events_game_id_idx on public.game_events (game_id);

alter table public.game_events enable row level security;

create policy "game events readable via visible games" on public.game_events
  for select to authenticated
  using (
    exists (
      select 1 from public.games g
      where g.id = game_events.game_id
        and g.deleted_at is null
        and (
          (
            g.organization_id = public.current_user_organization_id()
            and public.org_has_active_subscription_tier(g.organization_id, array['manual', 'photo'])
          )
          or (
            g.organization_id = (select o.id from public.organizations o where o.is_platform_feed limit 1)
            and public.org_has_active_subscription_tier(public.current_user_organization_id(), array['pro'])
          )
        )
    )
  );

create policy "game events insertable via owned games" on public.game_events
  for insert to authenticated
  with check (
    exists (
      select 1 from public.games g
      where g.id = game_events.game_id
        and g.owner_user_id = auth.uid()
        and public.org_has_active_subscription_tier(g.organization_id, array['manual', 'photo'])
    )
  );

create policy "game events updatable via owned games" on public.game_events
  for update to authenticated
  using (
    exists (
      select 1 from public.games g
      where g.id = game_events.game_id
        and g.owner_user_id = auth.uid()
        and public.org_has_active_subscription_tier(g.organization_id, array['manual', 'photo'])
    )
  );

create policy "game events deletable via owned games" on public.game_events
  for delete to authenticated
  using (exists (select 1 from public.games g where g.id = game_events.game_id and g.owner_user_id = auth.uid()));

-- 3. team_game_advanced_stats — child of games, same shape ------------------

create table public.team_game_advanced_stats (
  id bigint generated always as identity primary key,
  game_id bigint not null references public.games (id) on delete cascade,
  team_id bigint not null references public.teams (id),
  points_off_turnovers integer not null,
  second_chance_points integer not null,
  fastbreak_points integer not null,
  points_in_the_paint integer not null,
  unique (game_id, team_id)
);

alter table public.team_game_advanced_stats enable row level security;

create policy "team game advanced stats readable via visible games" on public.team_game_advanced_stats
  for select to authenticated
  using (
    exists (
      select 1 from public.games g
      where g.id = team_game_advanced_stats.game_id
        and g.deleted_at is null
        and (
          (
            g.organization_id = public.current_user_organization_id()
            and public.org_has_active_subscription_tier(g.organization_id, array['manual', 'photo'])
          )
          or (
            g.organization_id = (select o.id from public.organizations o where o.is_platform_feed limit 1)
            and public.org_has_active_subscription_tier(public.current_user_organization_id(), array['pro'])
          )
        )
    )
  );

create policy "team game advanced stats writable via owned games" on public.team_game_advanced_stats
  for all to authenticated
  using (exists (select 1 from public.games g where g.id = team_game_advanced_stats.game_id and g.owner_user_id = auth.uid()))
  with check (
    exists (
      select 1 from public.games g
      where g.id = team_game_advanced_stats.game_id
        and g.owner_user_id = auth.uid()
        and public.org_has_active_subscription_tier(g.organization_id, array['manual', 'photo'])
    )
  );

-- 4. shot_zones, shot_events — team/player/season-scoped, own owner/org ----

create table public.shot_zones (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.teams (id),
  player_id bigint references public.players (id), -- NULL = team total row
  season_id bigint not null references public.seasons (id),
  zone text not null check (zone in ('at_rim', 'mid_range', 'corner_3', 'wing_3', 'top_key_3')),
  fgm integer not null,
  fga integer not null,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null
);

create index shot_zones_team_season_idx on public.shot_zones (team_id, season_id);
create index shot_zones_player_season_idx on public.shot_zones (player_id, season_id);

create table public.shot_events (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.teams (id),
  player_id bigint references public.players (id),
  season_id bigint not null references public.seasons (id),
  x real not null,
  y real not null,
  made boolean not null,
  value integer not null, -- 2 or 3
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null
);

create index shot_events_team_season_idx on public.shot_events (team_id, season_id);
create index shot_events_player_season_idx on public.shot_events (player_id, season_id);

alter table public.shot_zones enable row level security;
alter table public.shot_events enable row level security;

create policy "shot zones readable within own manual or photo org" on public.shot_zones
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "shot zones readable via platform feed for pro tier" on public.shot_zones
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = (select o.id from public.organizations o where o.is_platform_feed limit 1)
    and public.org_has_active_subscription_tier(public.current_user_organization_id(), array['pro'])
  );
create policy "shot zones insertable by owner in manual or photo org" on public.shot_zones
  for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "shot zones updatable by owner in manual or photo org" on public.shot_zones
  for update to authenticated
  using (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "shot zones deletable by owner" on public.shot_zones
  for delete to authenticated using (owner_user_id = auth.uid());

create policy "shot events readable within own manual or photo org" on public.shot_events
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "shot events readable via platform feed for pro tier" on public.shot_events
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = (select o.id from public.organizations o where o.is_platform_feed limit 1)
    and public.org_has_active_subscription_tier(public.current_user_organization_id(), array['pro'])
  );
create policy "shot events insertable by owner in manual or photo org" on public.shot_events
  for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "shot events updatable by owner in manual or photo org" on public.shot_events
  for update to authenticated
  using (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "shot events deletable by owner" on public.shot_events
  for delete to authenticated using (owner_user_id = auth.uid());

-- 5. scouting_reports — own owner/org; scouting_report_player_notes derives -

create table public.scouting_reports (
  id bigint generated always as identity primary key,
  our_team_id bigint not null references public.teams (id),
  opponent_team_id bigint not null references public.teams (id),
  season_id bigint not null references public.seasons (id),
  game_date date not null,
  keys_to_game jsonb not null default '[]'::jsonb,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null
);

create index scouting_reports_teams_idx on public.scouting_reports (our_team_id, opponent_team_id, season_id);

create table public.scouting_report_player_notes (
  id bigint generated always as identity primary key,
  report_id bigint not null references public.scouting_reports (id) on delete cascade,
  player_id bigint not null references public.players (id),
  notes jsonb not null default '[]'::jsonb,
  photo_path text
);

create index scouting_report_player_notes_report_idx on public.scouting_report_player_notes (report_id);

alter table public.scouting_reports enable row level security;
alter table public.scouting_report_player_notes enable row level security;

create policy "scouting reports readable within own manual or photo org" on public.scouting_reports
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "scouting reports readable via platform feed for pro tier" on public.scouting_reports
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = (select o.id from public.organizations o where o.is_platform_feed limit 1)
    and public.org_has_active_subscription_tier(public.current_user_organization_id(), array['pro'])
  );
create policy "scouting reports insertable by owner in manual or photo org" on public.scouting_reports
  for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "scouting reports updatable by owner in manual or photo org" on public.scouting_reports
  for update to authenticated
  using (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "scouting reports deletable by owner" on public.scouting_reports
  for delete to authenticated using (owner_user_id = auth.uid());

create policy "scouting report notes readable via visible reports" on public.scouting_report_player_notes
  for select to authenticated
  using (
    exists (
      select 1 from public.scouting_reports r
      where r.id = scouting_report_player_notes.report_id
        and (
          (
            r.organization_id = public.current_user_organization_id()
            and public.org_has_active_subscription_tier(r.organization_id, array['manual', 'photo'])
          )
          or (
            r.organization_id = (select o.id from public.organizations o where o.is_platform_feed limit 1)
            and public.org_has_active_subscription_tier(public.current_user_organization_id(), array['pro'])
          )
        )
    )
  );
create policy "scouting report notes writable via owned reports" on public.scouting_report_player_notes
  for all to authenticated
  using (exists (select 1 from public.scouting_reports r where r.id = scouting_report_player_notes.report_id and r.owner_user_id = auth.uid()))
  with check (
    exists (
      select 1 from public.scouting_reports r
      where r.id = scouting_report_player_notes.report_id
        and r.owner_user_id = auth.uid()
        and public.org_has_active_subscription_tier(r.organization_id, array['manual', 'photo'])
    )
  );

-- 6. plays — team-scoped playbook diagrams, own owner/org -------------------

create table public.plays (
  id bigint generated always as identity primary key,
  team_id bigint references public.teams (id),
  name text not null,
  data jsonb not null, -- { frames: PlayFrame[] }
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index plays_team_idx on public.plays (team_id);

create trigger plays_set_updated_at
  before update on public.plays
  for each row execute function public.set_updated_at();

alter table public.plays enable row level security;

create policy "plays readable within own manual or photo org" on public.plays
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "plays readable via platform feed for pro tier" on public.plays
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = (select o.id from public.organizations o where o.is_platform_feed limit 1)
    and public.org_has_active_subscription_tier(public.current_user_organization_id(), array['pro'])
  );
create policy "plays insertable by owner in manual or photo org" on public.plays
  for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "plays updatable by owner in manual or photo org" on public.plays
  for update to authenticated
  using (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );
create policy "plays deletable by owner" on public.plays
  for delete to authenticated using (owner_user_id = auth.uid());

-- 7. ocr_cache — shared, cost-avoidance only, no ownership -------------------
-- A cache hit on the same image hash saves everyone the Claude API cost,
-- not just the original uploader — same "open" visibility as the shared
-- leagues/teams/players reference data.

create table public.ocr_cache (
  image_hash text primary key,
  result_json jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.ocr_cache enable row level security;

create policy "ocr cache readable by signed-in users" on public.ocr_cache
  for select to authenticated using (true);
create policy "ocr cache insertable by signed-in users" on public.ocr_cache
  for insert to authenticated with check (true);

-- 8. Drop the local<->remote sync-bridge leftovers ---------------------------
-- (sync_map and games.pending_sync/synced_at only ever existed to bridge
-- local SQLite and Supabase during the earlier sync-cache design — with
-- SQLite retired there's only one store, nothing left to reconcile)

alter table public.games drop column if exists pending_sync;
alter table public.games drop column if exists synced_at;
