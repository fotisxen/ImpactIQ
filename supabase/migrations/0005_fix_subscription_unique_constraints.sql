-- Fixes upsert compatibility on `subscriptions`. PostgREST's upsert (used
-- by the Stripe webhook handler) targets ON CONFLICT by column name only —
-- it can't match a partial unique index (one with a WHERE clause), which
-- is what 0003 created. Plain UNIQUE constraints have the identical
-- practical effect here anyway, since Postgres treats NULLs as distinct
-- for uniqueness: multiple organization-owned rows (user_id IS NULL) or
-- user-owned rows (organization_id IS NULL) still don't conflict with
-- each other either way.

drop index if exists public.subscriptions_one_per_user;
drop index if exists public.subscriptions_one_per_org;

alter table public.subscriptions add constraint subscriptions_user_id_key unique (user_id);
alter table public.subscriptions add constraint subscriptions_organization_id_key unique (organization_id);
