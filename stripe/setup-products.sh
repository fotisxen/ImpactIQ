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
# Supabase SQL editor to fill in supabase/migrations/0010_annual_tier_restructure.sql's
# placeholder price IDs (or re-run that migration's INSERT statement with
# the real values).

set -euo pipefail

id_of() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id"; }

echo "Creating: Manual plan..."
MANUAL_PRODUCT=$(stripe products create --name="Box Score Analytics — Manual" -d "metadata[app]=boxscore" -d "metadata[tier]=manual" | id_of)
MANUAL_YEAR=$(stripe prices create --product="$MANUAL_PRODUCT" --unit-amount=20000 --currency=eur -d "recurring[interval]=year" | id_of)

echo "Creating: Photo plan..."
PHOTO_PRODUCT=$(stripe products create --name="Box Score Analytics — Photo" -d "metadata[app]=boxscore" -d "metadata[tier]=photo" | id_of)
PHOTO_YEAR=$(stripe prices create --product="$PHOTO_PRODUCT" --unit-amount=50000 --currency=eur -d "recurring[interval]=year" | id_of)

echo "Creating: Pro plan..."
PRO_PRODUCT=$(stripe products create --name="Box Score Analytics — Pro" -d "metadata[app]=boxscore" -d "metadata[tier]=pro" | id_of)
PRO_YEAR=$(stripe prices create --product="$PRO_PRODUCT" --unit-amount=400000 --currency=eur -d "recurring[interval]=year" | id_of)

cat <<SQL

============================================================
Paste this into the Supabase SQL editor:
============================================================

insert into public.stripe_prices (key, stripe_price_id) values
  ('manual_year', '$MANUAL_YEAR'),
  ('photo_year', '$PHOTO_YEAR'),
  ('pro_year', '$PRO_YEAR')
on conflict (key) do update set stripe_price_id = excluded.stripe_price_id;

SQL
