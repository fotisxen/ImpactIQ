-- ============================================================================
-- Box Score Analytics — subscriptions
--
-- Two independent subscriptions per account:
--   1. `subscriptions` — the base app-usage plan. tier = 'individual' (one
--      person) or 'team' (an organization; members share data — see
--      org_has_active_team_subscription()). Billed monthly or yearly.
--   2. `upload_subscriptions` — the optional "Upload a Photo" add-on,
--      tiered by how many photo uploads are allowed per month
--      (`upload_plans`). Independent of the base plan: manual entry only
--      needs an active base subscription; the OCR upload feature also
--      needs an active upload_subscription with remaining quota.
--
-- Both follow the same cancel semantics: canceling sets
-- `cancel_at_period_end = true` and the row stays `status = 'active'` (full
-- access continues) until `current_period_end` passes. A scheduled job (or
-- the Stripe webhook handler) flips status to 'canceled' once the period
-- actually ends. Nothing in this file talks to Stripe directly — these
-- tables are what a Stripe webhook (via a Supabase Edge Function) keeps in
-- sync, and what the app reads to decide what the user can do.
-- ============================================================================

-- 1. Base app subscription --------------------------------------------------

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('user', 'organization')),
  user_id uuid references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete cascade,
  tier text not null check (tier in ('individual', 'team')),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  status text not null default 'inactive'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'inactive')),
  seat_count integer not null default 1,           -- team only: paid seats (billing math: 8€ or 15€ base + 6€ × max(seat_count-2, 0))
  current_period_start timestamptz,
  current_period_end timestamptz,                   -- access is valid through this date even after cancel_at_period_end
  cancel_at_period_end boolean not null default false,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_owner_shape check (
    (owner_type = 'user' and user_id is not null and organization_id is null and tier = 'individual')
    or (owner_type = 'organization' and organization_id is not null and user_id is null and tier = 'team')
  )
);

-- One active/pending base subscription per owner at a time.
create unique index subscriptions_one_per_user
  on public.subscriptions (user_id) where owner_type = 'user';
create unique index subscriptions_one_per_org
  on public.subscriptions (organization_id) where owner_type = 'organization';

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- 2. "Upload a Photo" add-on -------------------------------------------------

create table public.upload_plans (
  id text primary key,                              -- e.g. 'starter', 'pro', 'studio'
  name text not null,
  monthly_upload_limit integer not null,
  price_cents integer not null,
  currency text not null default 'eur',
  sort_order integer not null default 0
);

insert into public.upload_plans (id, name, monthly_upload_limit, price_cents, sort_order) values
  ('starter', 'Starter', 20, 500, 1),
  ('pro', 'Pro', 50, 1000, 2),
  ('studio', 'Studio', 150, 2000, 3);

create table public.upload_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_id text not null references public.upload_plans (id),
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  status text not null default 'inactive'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'inactive')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create trigger upload_subscriptions_set_updated_at
  before update on public.upload_subscriptions
  for each row execute function public.set_updated_at();

-- Usage log — one row per successful photo upload. Counting rows in the
-- current billing window (rather than an incrementing counter column)
-- means a plan change or period rollover can never desync from reality,
-- and it doubles as an audit trail.
create table public.photo_upload_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index photo_upload_events_user_period_idx
  on public.photo_upload_events (user_id, created_at);

-- 3. Helper functions ---------------------------------------------------------

-- Supersedes the organizations.subscription_tier/subscription_status stub
-- from 0001 — real subscription state (with period end, cancel flag,
-- Stripe ids) now lives in `subscriptions`, not on organizations directly.
create or replace function public.org_has_active_team_subscription(org_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.organization_id = org_id
      and s.owner_type = 'organization'
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;

-- True if this user currently has base-app access, whether through their
-- own individual subscription or through an organization's team plan.
create or replace function public.user_has_base_access(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select
    exists (
      select 1 from public.subscriptions s
      where s.user_id = uid
        and s.owner_type = 'user'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    )
    or exists (
      select 1 from public.profiles p
      where p.id = uid
        and p.organization_id is not null
        and public.org_has_active_team_subscription(p.organization_id)
    );
$$;

-- Uploads used in the CURRENT billing period (defaults to "this calendar
-- month so far" if the user has no upload_subscriptions row at all, so the
-- function is still meaningful before anyone has subscribed).
create or replace function public.upload_usage_this_period(uid uuid)
returns integer
language sql
stable
security definer set search_path = public
as $$
  select count(*)::integer
  from public.photo_upload_events e
  where e.user_id = uid
    and e.created_at >= coalesce(
      (select s.current_period_start from public.upload_subscriptions s where s.user_id = uid),
      date_trunc('month', now())
    );
$$;

-- 4. Row-Level Security -------------------------------------------------------

alter table public.subscriptions enable row level security;
alter table public.upload_plans enable row level security;
alter table public.upload_subscriptions enable row level security;
alter table public.photo_upload_events enable row level security;

-- Plans are public reference data (pricing page needs it pre-login too).
create policy "upload plans are readable by anyone" on public.upload_plans
  for select to anon, authenticated using (true);

-- A user reads their own individual subscription, or their org's team
-- subscription (so teammates can all see the plan they're on).
create policy "subscriptions readable by owner or teammates" on public.subscriptions
  for select to authenticated
  using (
    (owner_type = 'user' and user_id = auth.uid())
    or (
      owner_type = 'organization'
      and organization_id in (select organization_id from public.profiles where id = auth.uid())
    )
  );

-- Client-side writes are limited to canceling — everything else (creating a
-- subscription, changing tier, seat_count, period dates, Stripe ids) is
-- driven by the Stripe webhook handler running with the service_role key
-- (which bypasses RLS entirely, but NOT the trigger guards below — those
-- run for every UPDATE regardless of role, and explicitly let service_role
-- through). The RLS policy only checks ownership; the actual "you may only
-- flip cancel_at_period_end" rule is enforced by a BEFORE UPDATE trigger,
-- which has real access to OLD vs NEW — a self-referential subquery inside
-- WITH CHECK can't reliably see the pre-update row and would be a no-op.
create policy "user can update their own individual subscription" on public.subscriptions
  for update to authenticated
  using (owner_type = 'user' and user_id = auth.uid())
  with check (owner_type = 'user' and user_id = auth.uid());

create or replace function public.guard_subscription_client_update()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.status is distinct from old.status
    or new.tier is distinct from old.tier
    or new.billing_interval is distinct from old.billing_interval
    or new.seat_count is distinct from old.seat_count
    or new.current_period_start is distinct from old.current_period_start
    or new.current_period_end is distinct from old.current_period_end
    or new.stripe_customer_id is distinct from old.stripe_customer_id
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.owner_type is distinct from old.owner_type
    or new.user_id is distinct from old.user_id
    or new.organization_id is distinct from old.organization_id
  then
    raise exception 'Only cancel_at_period_end can be changed directly; everything else is set by the billing sync.';
  end if;
  return new;
end;
$$;

create trigger subscriptions_guard_client_update
  before update on public.subscriptions
  for each row execute function public.guard_subscription_client_update();

create policy "upload subscriptions readable by owner" on public.upload_subscriptions
  for select to authenticated using (user_id = auth.uid());

create policy "user can update their own upload subscription" on public.upload_subscriptions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.guard_upload_subscription_client_update()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.status is distinct from old.status
    or new.plan_id is distinct from old.plan_id
    or new.billing_interval is distinct from old.billing_interval
    or new.current_period_start is distinct from old.current_period_start
    or new.current_period_end is distinct from old.current_period_end
    or new.stripe_customer_id is distinct from old.stripe_customer_id
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.user_id is distinct from old.user_id
  then
    raise exception 'Only cancel_at_period_end can be changed directly; everything else is set by the billing sync.';
  end if;
  return new;
end;
$$;

create trigger upload_subscriptions_guard_client_update
  before update on public.upload_subscriptions
  for each row execute function public.guard_upload_subscription_client_update();

create policy "photo upload events readable by owner" on public.photo_upload_events
  for select to authenticated using (user_id = auth.uid());

create policy "photo upload events insertable by owner" on public.photo_upload_events
  for insert to authenticated with check (user_id = auth.uid());

-- 5. Drop the superseded stub columns on organizations -----------------------
-- (subscription state now lives in `subscriptions`; see
-- org_has_active_team_subscription() above, which the box-score-domain RLS
-- from 0002 already calls by name — no change needed there.)

-- Must drop the dependent view before the columns it selects, or Postgres
-- refuses with "cannot drop column ... because other objects depend on it".
drop view if exists public.profiles_with_subscription;

drop policy if exists "organizations are readable by anyone" on public.organizations;
alter table public.organizations drop column if exists subscription_tier;
alter table public.organizations drop column if exists subscription_status;
alter table public.organizations drop column if exists seat_limit;

create policy "organizations are readable by anyone" on public.organizations
  for select to anon, authenticated using (true);

create view public.profiles_with_subscription as
select
  p.*,
  o.name as organization_name,
  public.user_has_base_access(p.id) as has_base_access
from public.profiles p
left join public.organizations o on o.id = p.organization_id;
