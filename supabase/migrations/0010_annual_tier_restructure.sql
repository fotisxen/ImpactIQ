-- ============================================================================
-- Box Score Analytics — annual tier restructure (Manual / Photo / Pro)
--
-- Replaces the individual/team + monthly/yearly base plan, plus the
-- separate metered "Upload a Photo" add-on, with exactly 3 flat,
-- ANNUAL-ONLY, ORGANIZATION-scoped tiers:
--   manual (€200/yr)  — manual entry only, org-pooled visibility
--   photo  (€500/yr)  — manual entry + OCR upload included, no quota, org-pooled visibility
--   pro    (€4000/yr) — read-only; sees ONLY the platform-feed org's data
--
-- Clean cutover — no real paying subscribers exist yet, so old rows are
-- simply dropped/reshaped rather than migrated.
-- ============================================================================

-- 1. Drop the "Upload a Photo" metered add-on system entirely --------------
-- (no quota concept survives — Photo tier gets OCR included, flat annual price)

drop table if exists public.photo_upload_events cascade;
drop table if exists public.upload_subscriptions cascade;
drop table if exists public.upload_plans cascade;
drop function if exists public.guard_upload_subscription_client_update();
drop function if exists public.upload_usage_this_period(uuid);

-- 2. Retire the old games/box_scores RLS + helpers before reshaping --------

drop policy if exists "games readable by owner or teammates" on public.games;
drop policy if exists "games insertable by owner" on public.games;
drop policy if exists "games updatable by owner" on public.games;
drop policy if exists "games deletable by owner" on public.games;
drop policy if exists "box scores readable via visible games" on public.box_scores;
drop policy if exists "box scores insertable via owned games" on public.box_scores;
drop policy if exists "box scores updatable via owned games" on public.box_scores;
drop policy if exists "box scores deletable via owned games" on public.box_scores;

drop view if exists public.profiles_with_subscription;
drop function if exists public.org_has_active_team_subscription(uuid);
drop function if exists public.user_has_base_access(uuid);

-- 3. Reshape `subscriptions` -------------------------------------------------
-- Every subscription is now organization-owned — individual/user-owned
-- subscriptions no longer exist (matches the owner's own framing: every
-- tier is a club/org purchase, even a solo coach subscribes as an org of
-- one). billing_interval stays as a column (schema flexibility) but every
-- new row writes 'year'. seat_count stays but is vestigial — flat tier
-- pricing regardless of coach count, per-seat billing is dropped.

alter table public.subscriptions drop constraint if exists subscriptions_owner_shape;
alter table public.subscriptions drop constraint if exists subscriptions_tier_check;

-- Clean cutover — no real paying subscribers exist yet (confirmed with the
-- owner), so any row still shaped like the old individual/team model (test
-- rows from development, e.g. the dev-bypass "no Stripe subscription
-- attached" rows exercised while building the checkout flow) is dropped
-- rather than migrated.
delete from public.subscriptions where tier not in ('manual', 'photo', 'pro');

alter table public.subscriptions
  add constraint subscriptions_tier_check check (tier in ('manual', 'photo', 'pro'));

alter table public.subscriptions
  add constraint subscriptions_owner_shape check (
    owner_type = 'organization' and organization_id is not null and user_id is null
  );

comment on column public.subscriptions.billing_interval is
  'Kept for schema flexibility. Every tier is annual-only now — always written as ''year''.';
comment on column public.subscriptions.seat_count is
  'Vestigial — per-seat pricing is gone (flat tier price regardless of coach count). Left at default 1, unused by new checkout/webhook code.';

-- 4. organizations: Stripe customer moves here, plus the platform-feed flag -
-- Billing now dedupes at the org level (3 coaches at one club share one
-- Stripe customer, not one each). is_platform_feed flags the app owner's
-- own organization — set manually after this migration runs (real
-- operational data, not something a migration can seed) via:
--   update public.organizations set is_platform_feed = true where id = '<owner''s org id>';

alter table public.organizations add column if not exists stripe_customer_id text;
alter table public.organizations add column if not exists is_platform_feed boolean not null default false;

create unique index if not exists organizations_platform_feed_unique
  on public.organizations (is_platform_feed) where is_platform_feed;

alter table public.profiles drop column if exists stripe_customer_id;

-- 5. General "org has an active subscription in tier set X" helper ---------
-- Replaces org_has_active_team_subscription with a parameterized version so
-- both the pooled-visibility rule (manual/photo) and the platform-feed rule
-- (pro) share one implementation.

create or replace function public.org_has_active_subscription_tier(org_id uuid, tiers text[])
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.organization_id = org_id
      and s.owner_type = 'organization'
      and s.tier = any(tiers)
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;

-- 6. box_scores: add the one local column Supabase was missing -------------
-- (parity with electron/db/schema.sql's `srj` column, added there after
-- this table was first created — needed so push-sync doesn't silently drop it)

alter table public.box_scores add column if not exists srj integer not null default 0;

-- 7. New games/box_scores RLS ------------------------------------------------
-- Two SEPARATE select policies on `games` (Postgres OR's multiple permissive
-- policies together):
--   (a) manual/photo-tier orgs see their own pooled org data — this also
--       covers "owner sees their own game", since every game a manual/photo
--       account pushes always carries organization_id = their own org.
--   (b) pro-tier accounts see ONLY the flagged platform-feed org's data,
--       regardless of their own (nonexistent, since they can never push) uploads.

create policy "games readable within own manual or photo org" on public.games
  for select to authenticated
  using (
    deleted_at is null
    and organization_id is not null
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );

create policy "games readable via platform feed for pro tier" on public.games
  for select to authenticated
  using (
    deleted_at is null
    and organization_id is not null
    and organization_id = (select o.id from public.organizations o where o.is_platform_feed limit 1)
    and public.org_has_active_subscription_tier(public.current_user_organization_id(), array['pro'])
  );

-- Writes stay owner-scoped, but now ALSO require the caller's own org to be
-- on manual/photo — the RLS-level backstop (independent of the Electron-side
-- tier gate) that makes it structurally impossible for a Pro account to
-- ever write a game.

create policy "games insertable by owner in manual or photo org" on public.games
  for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );

create policy "games updatable by owner in manual or photo org" on public.games
  for update to authenticated
  using (
    owner_user_id = auth.uid()
    and organization_id = public.current_user_organization_id()
    and public.org_has_active_subscription_tier(organization_id, array['manual', 'photo'])
  );

create policy "games deletable by owner in manual or photo org" on public.games
  for delete to authenticated
  using (owner_user_id = auth.uid());

create policy "box scores readable via visible games" on public.box_scores
  for select to authenticated
  using (
    exists (
      select 1 from public.games g
      where g.id = box_scores.game_id
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

create policy "box scores insertable via owned games" on public.box_scores
  for insert to authenticated
  with check (
    exists (
      select 1 from public.games g
      where g.id = box_scores.game_id
        and g.owner_user_id = auth.uid()
        and public.org_has_active_subscription_tier(g.organization_id, array['manual', 'photo'])
    )
  );

create policy "box scores updatable via owned games" on public.box_scores
  for update to authenticated
  using (
    exists (
      select 1 from public.games g
      where g.id = box_scores.game_id
        and g.owner_user_id = auth.uid()
        and public.org_has_active_subscription_tier(g.organization_id, array['manual', 'photo'])
    )
  );

create policy "box scores deletable via owned games" on public.box_scores
  for delete to authenticated
  using (
    exists (select 1 from public.games g where g.id = box_scores.game_id and g.owner_user_id = auth.uid())
  );

-- Note: games.source CHECK already allows 'manual' (added in 0002) — no
-- change needed on the Supabase side. The bug (manual entries hardcoded to
-- 'photo') lives purely in electron/ipc.js's db:save-game handler.

-- 8. accept_team_invite(): drop the now-dead individual-subscription cancel --
-- Its UPDATE targeted owner_type='user' rows, which can no longer exist
-- after step 3 above — harmless as a permanent no-op, but worth removing
-- since it's directly superseded by this migration, not just incidentally
-- affected.

create or replace function public.accept_team_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_org_id uuid;
  v_status text;
begin
  select email into v_email from public.profiles where id = auth.uid();

  select organization_id, status into v_org_id, v_status
  from public.team_invites
  where id = p_invite_id and email = v_email;

  if v_org_id is null then
    raise exception 'Invite not found, or it was not sent to your email.';
  end if;
  if v_status <> 'pending' then
    raise exception 'This invite is no longer valid.';
  end if;

  update public.games
  set deleted_at = now()
  where owner_user_id = auth.uid() and deleted_at is null;

  update public.profiles
  set organization_id = v_org_id
  where id = auth.uid();

  update public.team_invites
  set status = 'accepted', accepted_at = now()
  where id = p_invite_id;
end;
$$;

-- 9. stripe_prices reseed -----------------------------------------------------
-- Placeholder IDs — replace with real Stripe Price IDs after running the
-- updated stripe/setup-products.sh (same dynamic-lookup design as before;
-- no further app-code changes needed to adjust actual € amounts later).

delete from public.stripe_prices
  where key in ('individual_month', 'individual_year', 'team_month', 'team_year', 'team_seat_month', 'team_seat_year');

insert into public.stripe_prices (key, stripe_price_id) values
  ('manual_year', 'REPLACE_ME_manual_year'),
  ('photo_year', 'REPLACE_ME_photo_year'),
  ('pro_year', 'REPLACE_ME_pro_year')
on conflict (key) do update set stripe_price_id = excluded.stripe_price_id;
