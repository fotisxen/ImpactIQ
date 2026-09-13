-- ============================================================================
-- Box Score Analytics — owner-only admin provisioning
--
-- The launch plan doesn't use Stripe self-checkout: only the app owner
-- creates accounts, assigns them to a club (organization), a default
-- basketball team, and a package (manual/photo/pro) — no payment flow
-- involved. This adds the two columns that support it; the actual
-- provisioning logic lives in new service-role Edge Functions
-- (admin-create-account, admin-list-organizations, admin-update-organization).
-- ============================================================================

alter table public.profiles add column if not exists is_platform_admin boolean not null default false;

-- Set manually after this migration runs — real operational data, same
-- pattern as organizations.is_platform_feed:
--   update public.profiles set is_platform_admin = true where id = '<owner's own user id>';

-- "Which basketball team should this org's Dashboard default to" — a
-- per-organization preference, deliberately NOT reusing teams.is_my_team
-- (that's a single shared boolean on the team row itself; if two different
-- Pro-tier orgs both got "their" team flagged that way, the second
-- assignment would silently overwrite the first for every other account
-- that later pulls the same shared platform-feed data). This column is the
-- per-org source of truth; electron/services/dataSync.js's pullCloudGames
-- derives the LOCAL is_my_team flag from it at sync time instead of ever
-- copying a shared remote boolean directly.
alter table public.organizations add column if not exists default_team_id bigint references public.teams(id) on delete set null;
