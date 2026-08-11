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
 *
 * Real clubs often play in more than one competition at once (e.g. a team
 * plays both its domestic league and a continental one — Partizan is
 * seeded under both ABA League and EuroLeague, correctly, since it really
 * plays in both). Matching each name independently and then just checking
 * whether they happened to land in the same league breaks the moment one
 * name's *first* match and the other name's *first* match aren't the same
 * league — even though a shared league exists. So instead: search each
 * league in turn, restrict matching to that league's own roster, and
 * return the first league where BOTH names resolve to two different teams
 * within it. Leagues with a known country (real seeded leagues, not an
 * ad-hoc hand-created one) are tried first.
 */
export function resolveGameTeams(
  teamName: string,
  opponentName: string,
  teams: Team[],
  leagues: League[]
): TeamMatchResult | null {
  const leagueHasCountry = new Map(leagues.map((l) => [l.id, !!l.country]));
  const leagueIds = [...new Set(teams.map((t) => t.league_id))].sort((a, b) => {
    const aHas = leagueHasCountry.get(a) ? 1 : 0;
    const bHas = leagueHasCountry.get(b) ? 1 : 0;
    return bHas - aHas;
  });

  for (const leagueId of leagueIds) {
    const leagueTeams = teams.filter((t) => t.league_id === leagueId);
    const team = findTeamMatch(teamName, leagueTeams);
    const opponent = findTeamMatch(opponentName, leagueTeams);
    if (team && opponent && team.id !== opponent.id) {
      return { leagueId, teamId: team.id, opponentId: opponent.id };
    }
  }
  return null;
}
