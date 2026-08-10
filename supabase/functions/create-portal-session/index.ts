// Opens the Stripe-hosted Customer Portal, where a user can update their
// payment method, view invoices, and change or cancel their subscription
// through Stripe's own UI — the simplest, most correct self-serve surface,
// and a fallback to the lighter-weight cancel-subscription function.
import { corsHeaders } from '../_shared/cors.ts';
import { getStripeClient } from '../_shared/stripe.ts';
import { getUserScopedClient } from '../_shared/supabaseClients.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = getUserScopedClient(req);
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (userErr || !user) throw new Error('Not authenticated.');

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();
    if (profileErr) throw new Error(profileErr.message);
    if (!profile.stripe_customer_id) {
      throw new Error("You don't have a billing account yet — subscribe to a plan first.");
    }

    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: 'boxscore-analytics://checkout?status=portal-closed',
    });

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
