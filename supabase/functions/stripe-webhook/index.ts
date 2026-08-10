// Receives Stripe's subscription lifecycle events and is the ONLY writer
// of subscription state in Supabase — nothing else sets status, dates, or
// Stripe ids on `subscriptions` / `upload_subscriptions` (see the trigger
// guards in supabase/migrations/0003_subscriptions.sql, which reject any
// client update to those columns and let this function's service_role
// writes through).
import type Stripe from 'npm:stripe@17';
import { getStripeClient } from '../_shared/stripe.ts';
import { getAdminClient } from '../_shared/supabaseClients.ts';

function mapStatus(status: Stripe.Subscription.Status): 'active' | 'trialing' | 'past_due' | 'canceled' | 'inactive' {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    default:
      return 'inactive'; // incomplete, incomplete_expired, paused
  }
}

async function upsertFromSubscription(admin: ReturnType<typeof getAdminClient>, sub: Stripe.Subscription) {
  const meta = sub.metadata as Record<string, string>;
  if (meta.app !== 'boxscore') return; // Not one of ours — ignore.

  const interval = sub.items.data[0]?.price.recurring?.interval === 'year' ? 'year' : 'month';
  const common = {
    status: mapStatus(sub.status),
    billing_interval: interval,
    current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    cancel_at_period_end: sub.cancel_at_period_end,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
  };

  if (meta.kind === 'upload') {
    const { error } = await admin
      .from('upload_subscriptions')
      .upsert(
        { user_id: meta.user_id, plan_id: meta.plan_id, ...common },
        { onConflict: 'user_id' }
      );
    if (error) throw new Error(`upload_subscriptions upsert: ${error.message}`);
    return;
  }

  if (meta.kind === 'base' && meta.tier === 'individual') {
    const { error } = await admin
      .from('subscriptions')
      .upsert(
        { owner_type: 'user', user_id: meta.user_id, organization_id: null, tier: 'individual', ...common },
        { onConflict: 'user_id' }
      );
    if (error) throw new Error(`subscriptions (individual) upsert: ${error.message}`);
    return;
  }

  if (meta.kind === 'base' && meta.tier === 'team') {
    const { error } = await admin
      .from('subscriptions')
      .upsert(
        {
          owner_type: 'organization',
          organization_id: meta.organization_id,
          user_id: null,
          tier: 'team',
          seat_count: Number(meta.seat_count ?? 1),
          ...common,
        },
        { onConflict: 'organization_id' }
      );
    if (error) throw new Error(`subscriptions (team) upsert: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!signature || !webhookSecret) {
    return new Response('Missing signature or webhook secret.', { status: 400 });
  }

  const rawBody = await req.text(); // Must be the raw, unparsed body — signature verification hashes these exact bytes.
  const stripe = getStripeClient();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err instanceof Error ? err.message : err}`, {
      status: 400,
    });
  }

  const admin = getAdminClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== 'subscription' || !session.subscription) break;
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        await upsertFromSubscription(admin, sub);
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await upsertFromSubscription(admin, sub);
        break;
      }
      default:
        break; // Ignore everything else — invoices, payment intents, etc.
    }
  } catch (err) {
    // Returning 500 makes Stripe retry with backoff — appropriate for a
    // transient DB write failure, not for a bug we'd just keep hitting.
    console.error('stripe-webhook handler error:', err);
    return new Response('Webhook handler error.', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
