// In-app cancel button: tells Stripe to stop renewing at the end of the
// current period (Stripe keeps charging nothing further; access stays
// live until current_period_end). The stripe-webhook function is what
// actually syncs cancel_at_period_end into Supabase once Stripe confirms
// it — this function just makes the request and lets the webhook be the
// single source of truth, rather than writing the flag from two places.
import { corsHeaders } from '../_shared/cors.ts';
import { getStripeClient } from '../_shared/stripe.ts';
import { getUserScopedClient } from '../_shared/supabaseClients.ts';

type Body = { kind: 'base' | 'upload' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = getUserScopedClient(req);
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (userErr || !user) throw new Error('Not authenticated.');

    const { kind } = (await req.json()) as Body;
    const table = kind === 'base' ? 'subscriptions' : 'upload_subscriptions';

    const query =
      kind === 'base'
        ? supabase.from('subscriptions').select('stripe_subscription_id').eq('owner_type', 'user').eq('user_id', user.id)
        : supabase.from('upload_subscriptions').select('stripe_subscription_id').eq('user_id', user.id);

    const { data: row, error: rowErr } = await query.maybeSingle();
    if (rowErr) throw new Error(rowErr.message);
    if (!row?.stripe_subscription_id) {
      throw new Error(
        kind === 'base'
          ? "No individual subscription found — team subscriptions are canceled by your club, not here."
          : 'No upload add-on subscription found.'
      );
    }

    const stripe = getStripeClient();
    await stripe.subscriptions.update(row.stripe_subscription_id, { cancel_at_period_end: true });

    return new Response(JSON.stringify({ ok: true, table }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
