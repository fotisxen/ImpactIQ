-- ============================================================================
-- Box Score Analytics — user/team scoping foundation
-- Run this in the Supabase SQL editor (or `supabase db push` if using the CLI).
--
-- Design notes:
--   - Email + password are handled entirely by Supabase Auth (auth.users).
--     We never store or touch passwords ourselves.
--   - `organizations` = the club a user belongs to (ΠΑΟΚ, Άρης, Ηρακλής, ...)
--     for SUBSCRIPTION and DATA-SHARING purposes. This is intentionally a
--     separate table from the app's existing `teams` table (which represents
--     basketball teams inside a league/game). Don't merge them.
--   - `profiles` is a 1:1 extension of auth.users holding everything that
--     isn't email/password.
--   - Team-subscription status lives on `organizations`, not duplicated onto
--     every profile row — a user's status is derived via organization_id.
-- ============================================================================

-- 1. Organizations (clubs) -----------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,                                  -- π.χ. "ΠΑΟΚ", "Άρης", "Ηρακλής"
  subscription_tier text not null default 'individual'
    check (subscription_tier in ('individual', 'team')),
  subscription_status text not null default 'inactive'
    check (subscription_status in ('active', 'trialing', 'past_due', 'canceled', 'inactive')),
  seat_limit integer,                                   -- null = unlimited / not enforced yet
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organizations is
  'A club/organization a user belongs to. Drives team-subscription billing and data sharing between members. Not the same as the basketball "teams" table.';

-- 2. Profiles (1:1 with auth.users) ---------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,                                  -- denormalized for convenient joins; auth.users is the source of truth
  first_name text not null,
  last_name text not null,
  birth_date date,                                      -- optional
  role text,                                             -- occupation, e.g. 'coach', 'analyst', 'scout', 'player'
  organization_id uuid references public.organizations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.profiles.role is
  'Occupation/role within the club, e.g. coach, analyst, scout — free text for now.';

create index profiles_organization_id_idx on public.profiles (organization_id);

-- Convenience view: does this user currently sit under an active team subscription?
create view public.profiles_with_subscription as
select
  p.*,
  o.name as organization_name,
  o.subscription_tier,
  o.subscription_status,
  (o.subscription_tier = 'team' and o.subscription_status = 'active') as has_team_subscription
from public.profiles p
left join public.organizations o on o.id = p.organization_id;

-- 3. Keep updated_at fresh --------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- 4. Auto-create a profile row whenever someone signs up -------------------
-- The extra fields (first_name, last_name, birth_date, role, organization_id)
-- are passed as `options.data` on the client's supabase.auth.signUp() call —
-- see usage example below. This trigger reads them out of auth.users and
-- inserts the matching profiles row automatically.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, first_name, last_name, birth_date, role, organization_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'first_name', ''),
    coalesce(new.raw_user_meta_data ->> 'last_name', ''),
    nullif(new.raw_user_meta_data ->> 'birth_date', '')::date,
    new.raw_user_meta_data ->> 'role',
    nullif(new.raw_user_meta_data ->> 'organization_id', '')::uuid
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5. Row-Level Security ------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;

-- Readable by anyone, including a not-yet-authenticated visitor — the
-- signup form needs this to populate a "which club do you belong to"
-- dropdown before the user has an account. Writes are NOT allowed from the
-- client — organizations are created/updated by your backend (billing
-- webhooks, admin tooling) using the service_role key, which bypasses RLS
-- entirely.
create policy "organizations are readable by anyone"
  on public.organizations for select
  to anon, authenticated
  using (true);

-- A user can always read and update their own profile.
create policy "users can read their own profile"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid());

-- Teammates can see each other's profile (needed for the team-subscription
-- data-sharing model: everyone on the team sees who else is on it). Remove
-- this policy if you don't want that visibility yet.
create policy "teammates can read each other's profile"
  on public.profiles for select
  to authenticated
  using (
    organization_id is not null
    and organization_id in (
      select organization_id from public.profiles where id = auth.uid()
    )
  );
