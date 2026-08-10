-- Fixes "infinite recursion detected in policy for relation profiles".
--
-- The "teammates can read each other's profile" policy (0001) queried
-- profiles.organization_id from *inside* a policy defined ON profiles —
-- evaluating that subquery re-triggers RLS on profiles, which re-runs the
-- same policy, forever. A SECURITY DEFINER helper breaks the cycle: it
-- looks up the caller's own organization_id without going through RLS
-- again, the same pattern already used successfully by
-- org_has_active_team_subscription() in 0003.

create or replace function public.current_user_organization_id()
returns uuid
language sql
stable
security definer set search_path = public
as $$
  select organization_id from public.profiles where id = auth.uid();
$$;

drop policy if exists "teammates can read each other's profile" on public.profiles;

create policy "teammates can read each other's profile" on public.profiles
  for select to authenticated
  using (
    organization_id is not null
    and organization_id = public.current_user_organization_id()
  );
