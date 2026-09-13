// Owner-only read: every club, its current package, and its default-team
// view preference — powers the Admin page's organization table.
//
// Deliberately NOT using a single nested PostgREST embed (organizations ->
// subscriptions/teams/profiles) — separate flat queries joined in JS here
// are more predictable and easier to debug than relying on embed-shape
// inference, which is what a real bug traced back to (tier/status were
// coming back empty in the app).
import { corsHeaders } from '../_shared/cors.ts';
import { getAdminClient } from '../_shared/supabaseClients.ts';
import { requirePlatformAdmin } from '../_shared/adminGuard.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    await requirePlatformAdmin(req);
    const admin = getAdminClient();

    const [{ data: orgs, error: orgErr }, { data: subs, error: subErr }, { data: profiles, error: profErr }, { data: teams, error: teamErr }] =
      await Promise.all([
        admin.from('organizations').select('id, name, default_team_id').order('name'),
        admin.from('subscriptions').select('organization_id, tier, status, current_period_end').eq('owner_type', 'organization'),
        admin.from('profiles').select('organization_id').not('organization_id', 'is', null),
        admin.from('teams').select('id, name'),
      ]);
    if (orgErr) throw new Error(`organizations: ${orgErr.message}`);
    if (subErr) throw new Error(`subscriptions: ${subErr.message}`);
    if (profErr) throw new Error(`profiles: ${profErr.message}`);
    if (teamErr) throw new Error(`teams: ${teamErr.message}`);

    const subByOrg = new Map((subs ?? []).map((s) => [s.organization_id, s]));
    const teamById = new Map((teams ?? []).map((t) => [t.id, t]));
    const memberCountByOrg = new Map<string, number>();
    for (const p of profiles ?? []) {
      memberCountByOrg.set(p.organization_id, (memberCountByOrg.get(p.organization_id) ?? 0) + 1);
    }

    const shaped = (orgs ?? []).map((o) => {
      const sub = subByOrg.get(o.id);
      const team = o.default_team_id ? teamById.get(o.default_team_id) : null;
      return {
        id: o.id,
        name: o.name,
        defaultTeamId: o.default_team_id ?? null,
        defaultTeamName: team?.name ?? null,
        tier: sub?.tier ?? null,
        status: sub?.status ?? null,
        currentPeriodEnd: sub?.current_period_end ?? null,
        memberCount: memberCountByOrg.get(o.id) ?? 0,
      };
    });

    return new Response(JSON.stringify({ organizations: shaped }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
