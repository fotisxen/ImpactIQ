import { Injectable } from '@angular/core';
import { League, Player, Season, Team } from '../models/box-score.model';

/**
 * Thin pass-through wrapper around the league/season/team/player slice of
 * window.boxscoreApi, shared by the game-context picker and the dashboard.
 */
@Injectable({ providedIn: 'root' })
export class EntitiesService {
  listLeagues(): Promise<League[]> {
    return window.boxscoreApi.listLeagues();
  }

  createLeague(league: { name: string; country?: string; tier?: string }): Promise<number> {
    return window.boxscoreApi.createLeague(league);
  }

  listSeasons(leagueId: number): Promise<Season[]> {
    return window.boxscoreApi.listSeasons(leagueId);
  }

  createSeason(season: { leagueId: number; year: string }): Promise<number> {
    return window.boxscoreApi.createSeason(season);
  }

  listTeams(): Promise<Team[]> {
    return window.boxscoreApi.listTeams();
  }

  createTeam(team: { leagueId: number; name: string; isMyTeam?: boolean }): Promise<number> {
    return window.boxscoreApi.createTeam(team);
  }

  listPlayers(teamId: number): Promise<Player[]> {
    return window.boxscoreApi.listPlayers(teamId);
  }
}
