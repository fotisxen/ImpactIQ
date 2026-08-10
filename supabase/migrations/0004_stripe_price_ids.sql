-- ============================================================================
-- Box Score Analytics — Stripe price-ID lookup
--
-- Maps this app's plan concepts to Stripe Price IDs, so the Edge Functions
-- that create Checkout Sessions don't hardcode them. Populate these AFTER
-- creating the products/prices in Stripe (see the CLI script provided
-- alongside this migration) — the INSERTs at the bottom use placeholder
-- IDs you must replace with your real `price_...` values.
-- ============================================================================

create table public.stripe_prices (
  key text primary key,   -- 'individual_month' | 'individual_year' | 'team_month' | 'team_year' | 'team_seat_month'
  stripe_price_id text not null
);

alter table public.upload_plans add column stripe_price_id text;

-- One Stripe customer per user, reused across the base subscription and
-- the upload add-on so a person isn't billed as two separate customers.
alter table public.profiles add column stripe_customer_id text;

alter table public.stripe_prices enable row level security;

-- Price IDs aren't secret (they're visible in any Checkout redirect anyway)
-- — readable by anyone so the app/pricing page can show real prices;
-- writes go through the service_role key only (no client policy for them).
create policy "stripe prices are readable by anyone" on public.stripe_prices
  for select to anon, authenticated using (true);

-- ----------------------------------------------------------------------------
-- Fill these in after running the product/price creation script. Re-run
-- with updated values any time — ON CONFLICT keeps this idempotent.
-- ----------------------------------------------------------------------------

insert into public.stripe_prices (key, stripe_price_id) values
  ('individual_month', 'price_1U2nfsCRMaNsxd7BQiLCKG0R'),
  ('individual_year', 'price_1U2nftCRMaNsxd7B6XrknKAe'),
  ('team_month', 'price_1U2ng2CRMaNsxd7BATg4eWU0'),
  ('team_year', 'price_1U2ng3CRMaNsxd7B4ekf8H7W'),
  ('team_seat_month', 'price_1U2ng9CRMaNsxd7Bf0OHSeOS')
on conflict (key) do update set stripe_price_id = excluded.stripe_price_id;

update public.upload_plans set stripe_price_id = 'price_1U2ngACRMaNsxd7Bmra9aZMb' where id = 'starter';
update public.upload_plans set stripe_price_id = 'price_1U2ngGCRMaNsxd7BhnUL8QB9' where id = 'pro';
update public.upload_plans set stripe_price_id = 'price_1U2ngNCRMaNsxd7BtXaCcg5U' where id = 'studio';
