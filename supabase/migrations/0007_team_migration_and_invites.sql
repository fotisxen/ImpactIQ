-- ============================================================================
-- Box Score Analytics — individual→team migration + invite-gated joining
--
-- Two new behaviors:
--   1. Joining a team is no longer a free pick from a dropdown — it
--      requires an invite from an existing team member (or creating a
--      brand-new team). team_invites tracks who invited whom.
--   2. Joining a team soft-deletes the joiner's personal games (they lose
--      access to their own data and see only the team's from then on) —
--      "soft" because nothing is actually deleted from Postgres, in case a
--      future paid recovery feature needs it back.
-- ============================================================================

-- 1. Soft delete on games -----------------------------------------------------

alter table public.games add column deleted_at timestamptz;

drop policy if exists "games readable by owner or teammates" on public.games;
create policy "games readable by owner or teammates" on public.games
  for select to authenticated
  using (
    deleted_at is null
    and (
      owner_user_id = auth.uid()
      or (
        organization_id is not null
        and organization_id in (select organization_id from public.profiles where id = auth.uid())
        and public.org_has_active_team_subscription(organization_id)
      )
    )
  );

drop policy if exists "box scores readable via visible games" on public.box_scores;
create policy "box scores readable via visible games" on public.box_scores
  for select to authenticated
  using (
    exists (
      select 1 from public.games g
      where g.id = box_scores.game_id
        and g.deleted_at is null
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

-- 2. Organizations can now be self-created (needed for "create a new team") --

create policy "authenticated users can create organizations" on public.organizations
  for insert to authenticated with check (true);

-- 3. Invites ------------------------------------------------------------------

create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null,
  invited_by uuid references auth.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

-- One live invite per (org, email) at a time.
create unique index team_invites_pending_unique
  on public.team_invites (organization_id, email) where status = 'pending';

alter table public.team_invites enable row level security;

create policy "invites visible to org members or the invited email" on public.team_invites
  for select to authenticated
  using (
    organization_id = public.current_user_organization_id()
    or email = (select email from public.profiles where id = auth.uid())
  );

create policy "org members can create invites for their org" on public.team_invites
  for insert to authenticated
  with check (organization_id = public.current_user_organization_id());

create policy "org members can revoke invites they sent" on public.team_invites
  for update to authenticated
  using (organization_id = public.current_user_organization_id())
  with check (organization_id = public.current_user_organization_id());

-- 4. Accept / decline — the only ways an invite's status actually changes ----
-- SECURITY DEFINER because accepting needs to touch the caller's own games,
-- profile, and subscription in one atomic step, plus mark the invite
-- consumed; every statement inside is still scoped to auth.uid() (or an
-- invite explicitly verified to belong to the caller's own email), so this
-- can't be used to affect anyone else's data.

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

  update public.subscriptions
  set cancel_at_period_end = true
  where owner_type = 'user' and user_id = auth.uid() and status in ('active', 'trialing');

  update public.team_invites
  set status = 'accepted', accepted_at = now()
  where id = p_invite_id;
end;
$$;

grant execute on function public.accept_team_invite(uuid) to authenticated;

create or replace function public.decline_team_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select email into v_email from public.profiles where id = auth.uid();
  update public.team_invites
  set status = 'revoked'
  where id = p_invite_id and email = v_email and status = 'pending';
end;
$$;

grant execute on function public.decline_team_invite(uuid) to authenticated;
