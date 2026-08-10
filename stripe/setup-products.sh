#!/usr/bin/env bash
# Creates every Stripe product + price this app needs, in whichever mode
# your Stripe CLI is currently authenticated for (test mode until you
# deliberately switch — recommended for all of this).
#
# Prerequisites:
#   1. Install the Stripe CLI: https://stripe.com/docs/stripe-cli
#   2. stripe login
#
# Run:  bash stripe/setup-products.sh
#
# At the end it prints a ready-to-paste SQL block — copy that into the
# Supabase SQL editor to fill in supabase/migrations/0004_stripe_price_ids.sql's
# placeholder price IDs (or re-run that migration's INSERT/UPDATE
# statements with the real values).

set -euo pipefail

id_of() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id"; }

echo "Creating: Individual plan..."
IND_PRODUCT=$(stripe products create --name="Box Score Analytics — Individual" -d "metadata[app]=boxscore" -d "metadata[kind]=base" -d "metadata[tier]=individual" | id_of)
IND_MONTH=$(stripe prices create --product="$IND_PRODUCT" --unit-amount=800 --currency=eur -d "recurring[interval]=month" | id_of)
IND_YEAR=$(stripe prices create --product="$IND_PRODUCT" --unit-amount=8000 --currency=eur -d "recurring[interval]=year" | id_of)

echo "Creating: Team plan..."
TEAM_PRODUCT=$(stripe products create --name="Box Score Analytics — Team" -d "metadata[app]=boxscore" -d "metadata[kind]=base" -d "metadata[tier]=team" | id_of)
TEAM_MONTH=$(stripe prices create --product="$TEAM_PRODUCT" --unit-amount=1500 --currency=eur -d "recurring[interval]=month" | id_of)
TEAM_YEAR=$(stripe prices create --product="$TEAM_PRODUCT" --unit-amount=15000 --currency=eur -d "recurring[interval]=year" | id_of)

echo "Creating: Team extra seat (per-seat add-on beyond the first 2 accounts)..."
SEAT_PRODUCT=$(stripe products create --name="Box Score Analytics — Team Extra Seat" -d "metadata[app]=boxscore" -d "metadata[kind]=seat" | id_of)
SEAT_MONTH=$(stripe prices create --product="$SEAT_PRODUCT" --unit-amount=600 --currency=eur -d "recurring[interval]=month" | id_of)

echo "Creating: Upload add-on — Starter..."
STARTER_PRODUCT=$(stripe products create --name="Upload a Photo — Starter" -d "metadata[app]=boxscore" -d "metadata[kind]=upload" -d "metadata[plan_id]=starter" | id_of)
STARTER_MONTH=$(stripe prices create --product="$STARTER_PRODUCT" --unit-amount=500 --currency=eur -d "recurring[interval]=month" | id_of)

echo "Creating: Upload add-on — Pro..."
PRO_PRODUCT=$(stripe products create --name="Upload a Photo — Pro" -d "metadata[app]=boxscore" -d "metadata[kind]=upload" -d "metadata[plan_id]=pro" | id_of)
PRO_MONTH=$(stripe prices create --product="$PRO_PRODUCT" --unit-amount=1000 --currency=eur -d "recurring[interval]=month" | id_of)

echo "Creating: Upload add-on — Studio..."
STUDIO_PRODUCT=$(stripe products create --name="Upload a Photo — Studio" -d "metadata[app]=boxscore" -d "metadata[kind]=upload" -d "metadata[plan_id]=studio" | id_of)
STUDIO_MONTH=$(stripe prices create --product="$STUDIO_PRODUCT" --unit-amount=2000 --currency=eur -d "recurring[interval]=month" | id_of)

cat <<SQL

============================================================
Paste this into the Supabase SQL editor:
============================================================

insert into public.stripe_prices (key, stripe_price_id) values
  ('individual_month', '$IND_MONTH'),
  ('individual_year', '$IND_YEAR'),
  ('team_month', '$TEAM_MONTH'),
  ('team_year', '$TEAM_YEAR'),
  ('team_seat_month', '$SEAT_MONTH')
on conflict (key) do update set stripe_price_id = excluded.stripe_price_id;

update public.upload_plans set stripe_price_id = '$STARTER_MONTH' where id = 'starter';
update public.upload_plans set stripe_price_id = '$PRO_MONTH' where id = 'pro';
update public.upload_plans set stripe_price_id = '$STUDIO_MONTH' where id = 'studio';

SQL
