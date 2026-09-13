-- ============================================================================
-- Box Score Analytics — one-time setup of the owner's own "platform feed"
-- organization (see migration 0011's docstring on organizations.is_platform_feed).
-- Idempotent: safe to re-run, only acts if the owner has no org yet and/or
-- no org is currently flagged as the platform feed.
-- ============================================================================

do $$
declare
  v_user_id uuid;
  v_org_id uuid;
begin
  select id into v_user_id from auth.users where email = 'fotisxen@hotmail.com';
  if v_user_id is null then
    raise notice 'No user found with that email yet — skipping platform-feed setup.';
    return;
  end if;

  select organization_id into v_org_id from public.profiles where id = v_user_id;

  if v_org_id is null then
    insert into public.organizations (name) values ('Impact IQ HQ') returning id into v_org_id;
    update public.profiles set organization_id = v_org_id where id = v_user_id;
  end if;

  update public.organizations set is_platform_feed = true where id = v_org_id;
end $$;
