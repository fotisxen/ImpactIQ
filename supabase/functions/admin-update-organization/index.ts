// Owner-only update: change an existing club's package and/or its
// default-team view preference — e.g. moving Iraklis from Photo to Pro
// later, or pointing their default view at a different team mid-season.
import { corsHeaders } from '../_shared/cors.ts';
import { getAdminClient } from '../_shared/supabaseClients.ts';
import { requirePlatformAdmin } from '../_shared/adminGuard.ts';

type Body = { organizationId: string; tier?: 'manual' | 'photo' | 'pro'; defaultTeamId?: number | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    await requirePlatformAdmin(req);
    const body = (await req.json()) as Body;
    if (!body.organizationId) throw new Error('organizationId is required.');

    const admin = getAdminClient();

    if (body.tier) {
      if (!['manual', 'photo', 'pro'].includes(body.tier)) throw new Error('Invalid tier.');

      // UPDATE-then-fallback-INSERT rather than a blind upsert: preserves
      // every other column (status, period dates, future Stripe ids) on
      // the normal path, but self-heals if this org somehow has no
      // subscriptions row yet instead of silently updating zero rows.
      const { data: updated, error: updateErr } = await admin
        .from('subscriptions')
        .update({ tier: body.tier })
        .eq('organization_id', body.organizationId)
        .eq('owner_type', 'organization')
        .select('id');
      if (updateErr) throw new Error(`tier update: ${updateErr.message}`);

      if (!updated || updated.length === 0) {
        const { error: insertErr } = await admin.from('subscriptions').insert({
          owner_type: 'organization',
          organization_id: body.organizationId,
          user_id: null,
          tier: body.tier,
          status: 'active',
          billing_interval: 'year',
          cancel_at_period_end: false,
          current_period_start: new Date().toISOString(),
          current_period_end: null,
          stripe_customer_id: null,
          stripe_subscription_id: null,
        });
        if (insertErr) throw new Error(`tier insert: ${insertErr.message}`);
      }
    }

    if (body.defaultTeamId !== undefined) {
      const { error } = await admin
        .from('organizations')
        .update({ default_team_id: body.defaultTeamId })
        .eq('id', body.organizationId);
      if (error) throw new Error(`default team update: ${error.message}`);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
