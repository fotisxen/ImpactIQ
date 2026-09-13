// Creates a Stripe Checkout Session for the org's annual subscription
// (manual / photo / pro) and returns its URL. The Electron app opens that
// URL in the system browser; Stripe redirects back to a
// boxscore-analytics:// deep link on completion (see main.js).
import type Stripe from 'npm:stripe@17';
import { corsHeaders } from '../_shared/cors.ts';
import { getStripeClient } from '../_shared/stripe.ts';
import { getUserScopedClient } from '../_shared/supabaseClients.ts';

type Body = { tier: 'manual' | 'photo' | 'pro' };

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
    if (!['manual', 'photo', 'pro'].includes(body.tier)) throw new Error('Invalid tier.');

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('organization_id, email, organizations(stripe_customer_id)')
      .eq('id', user.id)
      .single();
    if (profileErr) throw new Error(profileErr.message);
    if (!profile.organization_id) {
      throw new Error('Create or join a club before subscribing.');
    }

    const stripe = getStripeClient();

    // Reuse one Stripe customer per organization — every tier is an org
    // purchase now, so billing dedupes at the club level, not per coach.
    const org = profile.organizations as unknown as { stripe_customer_id: string | null } | null;
    let customerId = org?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile.email,
        metadata: { supabase_organization_id: profile.organization_id },
      });
      customerId = customer.id;
      await supabase.from('organizations').update({ stripe_customer_id: customerId }).eq('id', profile.organization_id);
    }

    const { data: price, error: priceErr } = await supabase
      .from('stripe_prices')
      .select('stripe_price_id')
      .eq('key', `${body.tier}_year`)
      .single();
    if (priceErr || !price?.stripe_price_id) {
      throw new Error(`No Stripe price configured for ${body.tier}_year.`);
    }

    const metadata: Record<string, string> = {
      app: 'boxscore',
      tier: body.tier,
      organization_id: profile.organization_id as string,
    };

    const params: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: price.stripe_price_id, quantity: 1 }],
      success_url: 'boxscore-analytics://checkout?status=success',
      cancel_url: 'boxscore-analytics://checkout?status=cancelled',
      subscription_data: { metadata },
      metadata,
    };
    // Managed Payments (Stripe's automatic tax) requires a tax_code on
    // every Product, which isn't set up — that's a tax-registration
    // decision, not something to guess at. Disabled per Stripe's own
    // suggested fix until that's configured deliberately.
    (params as Record<string, unknown>).managed_payments = { enabled: false };

    const session = await stripe.checkout.sessions.create(params);

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
