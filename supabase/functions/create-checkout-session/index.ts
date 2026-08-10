// Creates a Stripe Checkout Session for either the base app subscription
// (individual or team) or the Upload a Photo add-on, and returns its URL.
// The Electron app opens that URL in the system browser; Stripe redirects
// back to a boxscore-analytics:// deep link on completion (see main.js).
import type Stripe from 'npm:stripe@17';
import { corsHeaders } from '../_shared/cors.ts';
import { getStripeClient } from '../_shared/stripe.ts';
import { getUserScopedClient } from '../_shared/supabaseClients.ts';

type BaseBody = { kind: 'base'; tier: 'individual' | 'team'; interval: 'month' | 'year'; seatCount?: number };
type UploadBody = { kind: 'upload'; planId: string };
type Body = BaseBody | UploadBody;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = getUserScopedClient(req);
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (userErr || !user) throw new Error('Not authenticated.');

    const body = (await req.json()) as Body;
    const stripe = getStripeClient();

    // Reuse one Stripe customer per user across both subscription types.
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('stripe_customer_id, organization_id, email')
      .eq('id', user.id)
      .single();
    if (profileErr) throw new Error(profileErr.message);

    let customerId = profile.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
    }

    const successUrl = 'boxscore-analytics://checkout?status=success';
    const cancelUrl = 'boxscore-analytics://checkout?status=cancelled';

    if (body.kind === 'upload') {
      const { data: plan, error: planErr } = await supabase
        .from('upload_plans')
        .select('stripe_price_id')
        .eq('id', body.planId)
        .single();
      if (planErr || !plan?.stripe_price_id) {
        throw new Error(`No Stripe price configured for upload plan "${body.planId}".`);
      }

      const uploadParams: Stripe.Checkout.SessionCreateParams = {
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        subscription_data: {
          metadata: { app: 'boxscore', kind: 'upload', user_id: user.id, plan_id: body.planId },
        },
        metadata: { app: 'boxscore', kind: 'upload', user_id: user.id, plan_id: body.planId },
      };
      // Managed Payments (Stripe's automatic tax) requires a tax_code on
      // every Product, which isn't set up — that's a tax-registration
      // decision, not something to guess at. Disabled per Stripe's own
      // suggested fix until that's configured deliberately.
      (uploadParams as Record<string, unknown>).managed_payments = { enabled: false };

      const session = await stripe.checkout.sessions.create(uploadParams);
      return new Response(JSON.stringify({ url: session.url }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Base subscription
    if (body.tier === 'team' && !profile.organization_id) {
      throw new Error('Join or create a club in your profile before subscribing to the Team plan.');
    }

    // The seat add-on's billing interval must match the base plan's — a
    // yearly subscription with a monthly-recurring line item produces
    // confusing proration and renewal behavior in Stripe.
    const seatPriceKey = `team_seat_${body.interval}`;
    const { data: prices, error: priceErr } = await supabase
      .from('stripe_prices')
      .select('key, stripe_price_id')
      .in('key', [`${body.tier}_${body.interval}`, seatPriceKey]);
    if (priceErr) throw new Error(priceErr.message);

    const planPrice = prices.find((p) => p.key === `${body.tier}_${body.interval}`)?.stripe_price_id;
    if (!planPrice) throw new Error(`No Stripe price configured for ${body.tier}/${body.interval}.`);

    const lineItems: { price: string; quantity: number }[] = [{ price: planPrice, quantity: 1 }];

    if (body.tier === 'team') {
      const seatCount = Math.max(body.seatCount ?? 1, 1);
      const extraSeats = Math.max(seatCount - 2, 0);
      if (extraSeats > 0) {
        const seatPrice = prices.find((p) => p.key === seatPriceKey)?.stripe_price_id;
        if (!seatPrice) throw new Error(`No Stripe price configured for ${seatPriceKey}.`);
        lineItems.push({ price: seatPrice, quantity: extraSeats });
      }
    }

    const metadata: Record<string, string> = {
      app: 'boxscore',
      kind: 'base',
      tier: body.tier,
      user_id: user.id,
      ...(body.tier === 'team'
        ? { organization_id: profile.organization_id as string, seat_count: String(body.seatCount ?? 1) }
        : {}),
    };

    const baseParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: { metadata },
      metadata,
    };
    (baseParams as Record<string, unknown>).managed_payments = { enabled: false };

    const session = await stripe.checkout.sessions.create(baseParams);

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
