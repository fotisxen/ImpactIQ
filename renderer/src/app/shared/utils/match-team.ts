import { League, Team } from '../../core/models/box-score.model';

function stripDiacritics(value: string): string {
  let result = '';
  for (const ch of value.normalize('NFD')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x0300 || code > 0x036f) result += ch;
  }
  return result;
}

function normalize(name: string): string {
  return stripDiacritics(name).toLowerCase().trim();
}

function findTeamMatch(name: string, teams: Team[]): Team | null {
  const target = normalize(name);
  if (!target) return null;

  const exact = teams.find((t) => normalize(t.name) === target);
  if (exact) return exact;

  const partial = teams.find((t) => {
    const candidate = normalize(t.name);
    return candidate.length > 2 && (target.includes(candidate) || candidate.includes(target));
  });
  return partial ?? null;
}

export interface TeamMatchResult {
  leagueId: number;
  teamId: number;
  opponentId: number;
}

/**
 * Matches OCR/manual-entered team names against the known team list to
 * auto-resolve which league and which two teams a box score belongs to.
 * Only returns a result when both names resolve to teams in the SAME
 * league — a mixed/ambiguous match isn't confident enough to auto-fill.
 * The user can always override via the pickers regardless.
 *
 * When a name matches teams in more than one league (e.g. a hand-created
 * league that happens to reuse a real club name), leagues with a known
 * country are preferred over ones without — that's the signal that a
 * league is a "real" seeded one rather than an ad-hoc duplicate.
 */
export function resolveGameTeams(
  teamName: string,
  opponentName: string,
  teams: Team[],
  leagues: League[]
): TeamMatchResult | null {
  const leagueHasCountry = new Map(leagues.map((l) => [l.id, !!l.country]));
  const rankedTeams = [...teams].sort((a, b) => {
    const aHas = leagueHasCountry.get(a.league_id) ? 1 : 0;
    const bHas = leagueHasCountry.get(b.league_id) ? 1 : 0;
    return bHas - aHas;
  });

  const team = findTeamMatch(teamName, rankedTeams);
  const opponent = findTeamMatch(opponentName, rankedTeams);
  if (!team || !opponent) return null;
  if (team.id === opponent.id || team.league_id !== opponent.league_id) return null;
  return { leagueId: team.league_id, teamId: team.id, opponentId: opponent.id };
}
