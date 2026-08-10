-- ============================================================================
-- Box Score Analytics — box-score domain (leagues, seasons, teams, players,
-- games, box_scores), with per-user / per-organization data scoping.
--
-- STATUS: this schema is ready to apply, but the Electron app does not read
-- or write it yet — game/box-score data still lives in local SQLite
-- (electron/db/schema.sql). Wiring electron/ipc.js to use this instead is a
-- separate, larger follow-up (every query becomes async, and it's worth
-- deciding first whether local SQLite stays as an offline cache or goes
-- away entirely). Apply this migration whenever you're ready to start that
-- work — it doesn't affect the app until something actually queries it.
--
-- Ownership model:
--   - leagues / seasons / teams / players stay SHARED reference data,
--     exactly like the pre-seeded European leagues/teams today — anyone
--     signed in can read and add to them. A team name/identity (e.g.
--     "ΠΑΟΚ") is the same row for every user; there's nothing private
--     about the existence of a team.
--   - games (and, through them, box_scores) are PRIVATE: every game
--     carries `owner_user_id` (whoever entered it) and an optional
--     `organization_id`. A game is visible to its owner, and — only when
--     the organization has an ACTIVE TEAM subscription — to everyone else
--     in that organization. This is the "team members share data" rule.
-- ============================================================================

create table public.leagues (
  id bigint generated always as identity primary key,
  name text not null,
  country text,
  tier text,
  source text not null default 'manual' check (source in ('manual', 'public_api')),
  created_at timestamptz not null default now()
);

create table public.seasons (
  id bigint generated always as identity primary key,
  league_id bigint not null references public.leagues (id) on delete cascade,
  year text not null,
  created_at timestamptz not null default now()
);

create table public.teams (
  id bigint generated always as identity primary key,
  league_id bigint not null references public.leagues (id) on delete cascade,
  name text not null,
  is_my_team boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.players (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.teams (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.games (
  id bigint generated always as identity primary key,
  season_id bigint not null references public.seasons (id) on delete cascade,
  date date not null,
  home_team_id bigint not null references public.teams (id),
  away_team_id bigint not null references public.teams (id),
  source text not null default 'photo' check (source in ('photo', 'manual', 'public_api')),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.box_scores (
  id bigint generated always as identity primary key,
  game_id bigint not null references public.games (id) on delete cascade,
  player_id bigint not null references public.players (id) on delete cascade,
  min numeric not null default 0,
  pts integer not null default 0,
  fgm integer not null default 0,
  fga integer not null default 0,
  tpm integer not null default 0,
  tpa integer not null default 0,
  ftm integer not null default 0,
  fta integer not null default 0,
  oreb integer not null default 0,
  dreb integer not null default 0,
  ast integer not null default 0,
  stl integer not null default 0,
  blk integer not null default 0,
  tov integer not null default 0,
  pf integer not null default 0,
  pfd integer not null default 0,
  plus_minus integer not null default 0
);

create index seasons_league_id_idx on public.seasons (league_id);
create index teams_league_id_idx on public.teams (league_id);
create index players_team_id_idx on public.players (team_id);
create index games_season_id_idx on public.games (season_id);
create index games_owner_user_id_idx on public.games (owner_user_id);
create index games_organization_id_idx on public.games (organization_id);
create index box_scores_player_id_idx on public.box_scores (player_id);
create index box_scores_game_id_idx on public.box_scores (game_id);

-- 1. Row-Level Security --------------------------------------------------

alter table public.leagues enable row level security;
alter table public.seasons enable row level security;
alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.box_scores enable row level security;

-- Shared reference data — same visibility model as `organizations`:
-- anyone signed in can read and contribute (mirrors today's pre-seeded,
-- everybody-shares-it European leagues/teams).
create policy "leagues readable by signed-in users" on public.leagues
  for select to authenticated using (true);
create policy "leagues insertable by signed-in users" on public.leagues
  for insert to authenticated with check (true);

create policy "seasons readable by signed-in users" on public.seasons
  for select to authenticated using (true);
create policy "seasons insertable by signed-in users" on public.seasons
  for insert to authenticated with check (true);

create policy "teams readable by signed-in users" on public.teams
  for select to authenticated using (true);
create policy "teams insertable by signed-in users" on public.teams
  for insert to authenticated with check (true);
create policy "teams updatable by signed-in users" on public.teams
  for update to authenticated using (true);

create policy "players readable by signed-in users" on public.players
  for select to authenticated using (true);
create policy "players insertable by signed-in users" on public.players
  for insert to authenticated with check (true);

-- Helper: is the given organization currently on an active team plan?
-- (Kept as a function so the same rule doesn't get duplicated/drift across
-- the games and box_scores policies below.)
--
-- Defined only if it doesn't already exist: migration 0003 later replaces
-- this with a version backed by the `subscriptions` table (once that
-- table exists) and drops the `organizations` columns this one reads. On
-- a fresh install those migrations run in order (0002 creates this,
-- 0003 upgrades it); skipping the create here when it's already present
-- also makes 0002 safe to (re)apply on a database where 0003 already ran.
do $do$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'org_has_active_team_subscription'
  ) then
    execute $func$
      create function public.org_has_active_team_subscription(org_id uuid)
      returns boolean
      language sql
      stable
      security definer set search_path = public
      as $body$
        select exists (
          select 1 from public.organizations o
          where o.id = org_id
            and o.subscription_tier = 'team'
            and o.subscription_status = 'active'
        );
      $body$;
    $func$;
  end if;
end;
$do$;

-- Private data — visible to the owner, or to teammates sharing the same
-- organization while that organization has an active team subscription.
create policy "games readable by owner or teammates" on public.games
  for select to authenticated
  using (
    owner_user_id = auth.uid()
    or (
      organization_id is not null
      and organization_id in (select organization_id from public.profiles where id = auth.uid())
      and public.org_has_active_team_subscription(organization_id)
    )
  );

create policy "games insertable by owner" on public.games
  for insert to authenticated
  with check (owner_user_id = auth.uid());

create policy "games updatable by owner" on public.games
  for update to authenticated
  using (owner_user_id = auth.uid());

create policy "games deletable by owner" on public.games
  for delete to authenticated
  using (owner_user_id = auth.uid());

-- box_scores has no owner column of its own — visibility is derived from
-- its parent game.
create policy "box scores readable via visible games" on public.box_scores
  for select to authenticated
  using (
    exists (
      select 1 from public.games g
      where g.id = box_scores.game_id
        and (
          g.owner_user_id = auth.uid()
          or (
            g.organization_id is not null
            and g.organization_id in (select organization_id from public.profiles where id = auth.uid())
            and public.org_has_active_team_subscription(g.organization_id)
          )
        )
    )
  );

create policy "box scores insertable via owned games" on public.box_scores
  for insert to authenticated
  with check (
    exists (select 1 from public.games g where g.id = box_scores.game_id and g.owner_user_id = auth.uid())
  );

create policy "box scores updatable via owned games" on public.box_scores
  for update to authenticated
  using (
    exists (select 1 from public.games g where g.id = box_scores.game_id and g.owner_user_id = auth.uid())
  );

create policy "box scores deletable via owned games" on public.box_scores
  for delete to authenticated
  using (
    exists (select 1 from public.games g where g.id = box_scores.game_id and g.owner_user_id = auth.uid())
  );
