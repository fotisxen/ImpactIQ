-- ============================================================================
-- Box Score Analytics — scouting report distribution to players
--
-- Two new tables + a private Storage bucket so a coach can publish a
-- scouting report PDF to their own club and see who's opened it, and a
-- separate player-facing (mobile) app can fetch exactly the current one.
--
-- Design notes:
--   - "The current report" for an organization is just the row in
--     published_reports with the latest published_at — no separate
--     is_current flag to keep in sync on every publish.
--   - report_views has a UNIQUE (report_id, viewer_id) so a player opening
--     the same report repeatedly is still exactly one row (upserted, not
--     inserted again) — the app cares "did they see it", not "how many times".
--   - Deliberately NOT reusing team_invites / accept_team_invite() for
--     players — that function soft-deletes the joiner's own personal games
--     and cancels their individual subscription on accept, which is
--     coach/analyst-specific behavior a player account must never trigger.
--     Player accounts are created directly by the create-player-account
--     Edge Function instead (see supabase/functions/create-player-account).
-- ============================================================================

-- 1. Published reports ---------------------------------------------------

create table public.published_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  storage_path text not null,           -- path within the scouting-reports bucket
  opponent_name text,                    -- display-only, e.g. "vs. Panathinaikos AKTOR"
  game_date text,                        -- display-only, ISO date as text (matches the app's own convention elsewhere)
  published_by uuid references auth.users (id) on delete set null,
  published_at timestamptz not null default now()
);

create index published_reports_org_latest_idx
  on public.published_reports (organization_id, published_at desc);

comment on table public.published_reports is
  'One row per scouting report a coach has published to their team. The "current" report for an organization is simply the row with the latest published_at.';

-- 2. Report views (read receipts) ----------------------------------------

create table public.report_views (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.published_reports (id) on delete cascade,
  viewer_id uuid not null references auth.users (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  unique (report_id, viewer_id)
);

comment on table public.report_views is
  'Read receipts. Unique per (report, viewer) — the mobile app upserts on open, bumping viewed_at, rather than inserting a new row every time.';

-- 3. Storage bucket --------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('scouting-reports', 'scouting-reports', false)
on conflict (id) do nothing;

-- Objects are stored as "{organization_id}/{filename}.pdf" — policies below
-- key off the first path segment to scope access to the uploader's own club.

create policy "org members can read their own club's scouting report files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'scouting-reports'
    and (storage.foldername(name))[1] = (
      select organization_id::text from public.profiles where id = auth.uid()
    )
  );

create policy "org members can upload their own club's scouting report files"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'scouting-reports'
    and (storage.foldername(name))[1] = (
      select organization_id::text from public.profiles where id = auth.uid()
    )
  );

-- 4. Row-Level Security -----------------------------------------------------

alter table public.published_reports enable row level security;
alter table public.report_views enable row level security;

create policy "org members can read their own club's published reports"
  on public.published_reports for select
  to authenticated
  using (
    organization_id in (
      select organization_id from public.profiles where id = auth.uid()
    )
  );

create policy "org members can publish reports for their own club"
  on public.published_reports for insert
  to authenticated
  with check (
    organization_id in (
      select organization_id from public.profiles where id = auth.uid()
    )
  );

-- Anyone in the same organization can see who's viewed a report (coaches
-- checking engagement); a viewer can only write their OWN row.
create policy "org members can read view receipts for their own club's reports"
  on public.report_views for select
  to authenticated
  using (
    report_id in (
      select id from public.published_reports
      where organization_id in (select organization_id from public.profiles where id = auth.uid())
    )
  );

create policy "a viewer can record their own view"
  on public.report_views for insert
  to authenticated
  with check (viewer_id = auth.uid());

create policy "a viewer can update their own view timestamp"
  on public.report_views for update
  to authenticated
  using (viewer_id = auth.uid())
  with check (viewer_id = auth.uid());
