-- ============================================================================
-- Box Score Analytics — platform admin bypasses RLS tier checks
--
-- Real bug caught via direct testing (not just review): the Electron/
-- Angular app-layer already lets the platform admin "do whatever"
-- regardless of their own org's subscription (electron/services/subscriptions.js's
-- getTier() short-circuits hasBaseAccess/canManualEntry/canUploadPhoto for
-- isPlatformAdmin) — but the actual RLS policies on games/box_scores/etc.
-- never knew about that bypass, so a platform-admin write was rejected
-- with "new row violates row-level security policy" whenever their own
-- profile's org didn't happen to carry an active manual/photo subscription
-- (the owner's own profile is on "Iraklis Team", a test/customer org, not
-- their platform-feed org — there's no reason it should need a real
-- subscription for the admin's own writes to work).
--
-- Fixed at the single shared helper every owner/org-scoped table's RLS
-- already calls (games, box_scores, game_events, team_game_advanced_stats,
-- shot_zones, shot_events, scouting_reports, scouting_report_player_notes,
-- plays) — one function redefinition fixes every one of them at once,
-- rather than editing each policy individually.
-- ============================================================================

create or replace function public.org_has_active_subscription_tier(org_id uuid, tiers text[])
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select
    coalesce((select p.is_platform_admin from public.profiles p where p.id = auth.uid()), false)
    or exists (
      select 1 from public.subscriptions s
      where s.organization_id = org_id
        and s.owner_type = 'organization'
        and s.tier = any(tiers)
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    );
$$;
