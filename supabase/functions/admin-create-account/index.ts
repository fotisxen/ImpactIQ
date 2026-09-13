// Owner-only account provisioning — no Stripe involved. Creates a user
// (same service-role auth.admin.createUser() pattern as
// create-player-account), creates or reuses the club they belong to, and
// activates a subscription directly (status:'active', no Stripe ids) —
// this is the permanent no-payment path while self-checkout is on hold,
// not a temporary bypass. The generated password is returned exactly once;
// it is never stored or logged anywhere.
import { corsHeaders } from '../_shared/cors.ts';
import { getAdminClient } from '../_shared/supabaseClients.ts';
import { requirePlatformAdmin } from '../_shared/adminGuard.ts';

type Body = {
  email: string;
  firstName: string;
  lastName: string;
  role?: string;
  organizationId?: string;
  organizationName?: string;
  tier: 'manual' | 'photo' | 'pro';
  defaultTeamId?: number;
};

function generatePassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 14);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    await requirePlatformAdmin(req);

    const body = (await req.json()) as Body;
    if (!body.email || !body.firstName || !body.lastName) {
      throw new Error('email, firstName, and lastName are all required.');
    }
    if (!['manual', 'photo', 'pro'].includes(body.tier)) throw new Error('Invalid tier.');
    if (!body.organizationId && !body.organizationName) {
      throw new Error('Provide either organizationId (existing club) or organizationName (new club).');
    }

    const admin = getAdminClient();

    let organizationId = body.organizationId ?? null;
    if (!organizationId) {
      const { data: org, error: orgErr } = await admin
        .from('organizations')
        .insert({ name: body.organizationName })
        .select('id')
        .single();
      if (orgErr) throw new Error(orgErr.message);
      organizationId = org.id;
    }

    if (body.defaultTeamId) {
      const { error: teamErr } = await admin
        .from('organizations')
        .update({ default_team_id: body.defaultTeamId })
        .eq('id', organizationId);
      if (teamErr) throw new Error(teamErr.message);
    }

    const password = generatePassword();
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: body.email,
      password,
      email_confirm: true, // no email-confirmation step — the owner hands the password over directly
      user_metadata: {
        first_name: body.firstName,
        last_name: body.lastName,
        role: body.role || null,
        organization_id: organizationId,
      },
    });
    if (createErr) throw new Error(createErr.message);
    // handle_new_user() (supabase/migrations/0001) copies user_metadata into
    // public.profiles automatically on insert — no separate profile write needed here.

    const { error: subErr } = await admin.from('subscriptions').upsert(
      {
        owner_type: 'organization',
        organization_id: organizationId,
        user_id: null,
        tier: body.tier,
        status: 'active',
        billing_interval: 'year',
        cancel_at_period_end: false,
        current_period_start: new Date().toISOString(),
        current_period_end: null, // no Stripe subscription — no renewal date, active until the owner changes it
        stripe_customer_id: null,
        stripe_subscription_id: null,
      },
      { onConflict: 'organization_id' }
    );
    if (subErr) throw new Error(`subscriptions upsert: ${subErr.message}`);

    return new Response(JSON.stringify({ email: created.user.email, password, organizationId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
