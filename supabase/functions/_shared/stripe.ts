import Stripe from 'npm:stripe@17';

export function getStripeClient(): Stripe {
  const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set (supabase secrets set STRIPE_SECRET_KEY=...).');
  }
  // Edge Functions run on Deno's fetch-based runtime, not Node — Stripe's
  // SDK needs to be told explicitly not to reach for Node's http client.
  return new Stripe(secretKey, {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
  });
}
