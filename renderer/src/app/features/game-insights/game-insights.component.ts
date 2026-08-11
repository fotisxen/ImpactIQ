import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  SegmentOption,
  SegmentedControlComponent,
} from '../../shared/components/segmented-control.component';
import type {
  GameInsight,
  GameInsightsResult,
  GameListEntry,
  PlayerListEntry,
  PlayerScoutingReport,
  Team,
  TeamScoutingReport,
} from '../../core/models/box-score.model';
import { ToastService } from '../../shared/services/toast.service';

type Side = 'home' | 'away';
type InsightsMode = 'game' | 'team' | 'player';

const MODE_OPTIONS: SegmentOption<InsightsMode>[] = [
  { label: 'By Game', value: 'game' },
  { label: 'By Team', value: 'team' },
  { label: 'By Player', value: 'player' },
];

@Component({
  selector: 'app-game-insights',
  standalone: true,
  imports: [FormsModule, SegmentedControlComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="insights-page">
      <header class="page-header">
        <h2>Insights</h2>
        <app-segmented-control [options]="modeOptions" [selected]="mode()" (selectedChange)="setMode($event)" />
      </header>
      <p class="hint">
        All computed on your machine by comparing against season/league averages — no API calls, no cost.
      </p>

      @if (mode() === 'game') {
        <div class="picker-card card">
          <input type="text" placeholder="Search by team name…" [(ngModel)]="gameSearch" class="search-input" />
          <div class="result-list">
            @for (g of filteredGames(); track g.gameId) {
              <button
                type="button"
                class="result-row"
                [class.active]="g.gameId === selectedGameId()"
                (click)="selectGame(g.gameId)"
              >
                <span class="result-title">{{ g.homeTeamName }} vs {{ g.awayTeamName }}</span>
                <span class="result-meta">{{ g.date }} · {{ g.leagueName }} {{ g.seasonYear }}</span>
              </button>
            } @empty {
              <p class="hint">No saved games yet.</p>
            }
          </div>
        </div>

        @if (loading()) {
          <p class="hint">Analyzing…</p>
        }

        @if (gameResult(); as r) {
          <div class="result-header card">
            <h3>{{ r.homeTeamName }} <span class="score">{{ r.homeScore }}</span> — <span class="score">{{ r.awayScore }}</span> {{ r.awayTeamName }}</h3>
            <p class="hint">{{ r.date }} · {{ r.leagueName }} {{ r.seasonYear }}</p>
          </div>

          <div class="team-columns">
            @for (side of sides; track side) {
              <div class="team-column card">
                <h4>
                  {{ side === 'home' ? r.homeTeamName : r.awayTeamName }}
                  <span class="badge" [class.badge-positive]="r.winner === side">
                    {{ r.winner === side ? 'Won' : r.winner === 'tie' ? 'Tied' : 'Lost' }}
                  </span>
                </h4>

                <div class="insight-group">
                  <h5 class="positive-heading">What went well</h5>
                  @for (i of positivesFor(r, side); track i.text) {
                    <p class="insight-line positive">{{ i.text }}</p>
                  } @empty {
                    <p class="hint">Nothing stood out above their usual level.</p>
                  }
                </div>

                <div class="insight-group">
                  <h5 class="negative-heading">What went less well</h5>
                  @for (i of negativesFor(r, side); track i.text) {
                    <p class="insight-line negative">{{ i.text }}</p>
                  } @empty {
                    <p class="hint">Nothing stood out below their usual level.</p>
                  }
                </div>
              </div>
            }
          </div>
        } @else if (selectedGameId() !== null && !loading()) {
          <p class="hint">Not enough game history yet to compare against — play a few more games first.</p>
        }
      }

      @if (mode() === 'team') {
        <div class="picker-card card">
          <input type="text" placeholder="Search by team name…" [(ngModel)]="teamSearch" class="search-input" />
          <div class="result-list">
            @for (t of filteredTeams(); track t.id) {
              <button
                type="button"
                class="result-row"
                [class.active]="t.id === selectedTeamId()"
                (click)="selectTeam(t.id)"
              >
                <span class="result-title">{{ t.name }}</span>
              </button>
            } @empty {
              <p class="hint">No teams yet.</p>
            }
          </div>
        </div>

        @if (loading()) {
          <p class="hint">Analyzing…</p>
        }

        @if (teamReport(); as r) {
          <div class="result-header card">
            <h3>{{ r.teamName }}</h3>
            <p class="hint">{{ r.leagueName }} · {{ r.games }} games · {{ r.wins }}-{{ r.losses }}</p>
          </div>

          <div class="team-columns">
            <div class="team-column card">
              <h4>Vs. league average</h4>
              <div class="insight-group">
                <h5 class="positive-heading">Strengths</h5>
                @for (i of strengthsOf(r.profileInsights); track i.text) {
                  <p class="insight-line positive">{{ i.text }}</p>
                } @empty {
                  <p class="hint">Nothing clearly above league average yet.</p>
                }
              </div>
              <div class="insight-group">
                <h5 class="negative-heading">Weaknesses</h5>
                @for (i of weaknessesOf(r.profileInsights); track i.text) {
                  <p class="insight-line negative">{{ i.text }}</p>
                } @empty {
                  <p class="hint">Nothing clearly below league average yet.</p>
                }
              </div>
            </div>

            <div class="team-column card">
              <h4>Key players</h4>
              @for (p of r.keyPlayers; track p.playerId) {
                <p class="insight-line">
                  <strong>{{ p.playerName }}</strong> — {{ numFmt(p.pts) }} PTS, {{ numFmt(p.reb) }} REB,
                  {{ numFmt(p.ast) }} AST {{ p.pie !== null ? '(' + pctFmt(p.pie) + ' PIE)' : '' }}
                </p>
              } @empty {
                <p class="hint">Not enough games yet to identify key players.</p>
              }

              <h4>How to beat them</h4>
              @for (i of r.lossPatternInsights; track i.text) {
                <p class="insight-line negative">{{ i.text }}</p>
              } @empty {
                <p class="hint">
                  {{ r.losses < 2 ? "Not enough losses yet to find a pattern." : "No clear pattern in their losses yet." }}
                </p>
              }
            </div>
          </div>
        } @else if (selectedTeamId() !== null && !loading()) {
          <p class="hint">Not enough games saved for this team yet.</p>
        }
      }

      @if (mode() === 'player') {
        <div class="picker-card card">
          <input type="text" placeholder="Search by player name…" [(ngModel)]="playerSearch" class="search-input" />
          <div class="result-list">
            @for (p of filteredPlayers(); track p.id) {
              <button
                type="button"
                class="result-row"
                [class.active]="p.id === selectedPlayerId()"
                (click)="selectPlayer(p.id)"
              >
                <span class="result-title">{{ p.name }}</span>
                <span class="result-meta">{{ p.teamName }}</span>
              </button>
            } @empty {
              <p class="hint">No players yet.</p>
            }
          </div>
        </div>

        @if (loading()) {
          <p class="hint">Analyzing…</p>
        }

        @if (playerReport(); as r) {
          <div class="result-header card">
            <h3>{{ r.playerName }}</h3>
            <p class="hint">{{ r.teamName }} · {{ r.leagueName }} · {{ r.games }} games</p>
          </div>

          <div class="team-columns">
            <div class="team-column card">
              <h4>Vs. league average</h4>
              <div class="insight-group">
                <h5 class="positive-heading">Strengths</h5>
                @for (i of strengthsOf(r.profileInsights); track i.text) {
                  <p class="insight-line positive">{{ i.text }}</p>
                } @empty {
                  <p class="hint">Nothing clearly above league average yet.</p>
                }
              </div>
              <div class="insight-group">
                <h5 class="negative-heading">Weaknesses</h5>
                @for (i of weaknessesOf(r.profileInsights); track i.text) {
                  <p class="insight-line negative">{{ i.text }}</p>
                } @empty {
                  <p class="hint">Nothing clearly below league average yet.</p>
                }
              </div>
            </div>

            <div class="team-column card">
              <h4>In wins vs. losses</h4>
              @for (i of r.winVsLossInsights; track i.text) {
                <p class="insight-line">{{ i.text }}</p>
              } @empty {
                <p class="hint">Not enough wins and losses yet to compare.</p>
              }
            </div>
          </div>
        } @else if (selectedPlayerId() !== null && !loading()) {
          <p class="hint">Not enough games saved for this player yet.</p>
        }
      }
    </section>
  `,
  styles: `
    .insights-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      padding: var(--space-6);
      max-width: 1100px;
    }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: var(--space-3);
    }
    .page-header h2 {
      font-size: 1.4rem;
    }
    .picker-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .search-input {
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
    }
    .result-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      max-height: 220px;
      overflow-y: auto;
    }
    .result-row {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      cursor: pointer;
      text-align: left;
    }
    .result-row:hover {
      border-color: var(--accent);
    }
    .result-row.active {
      border-color: var(--accent);
      background: var(--accent-muted);
    }
    .result-title {
      font-weight: 600;
      font-size: 0.88rem;
    }
    .result-meta {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .result-header h3 {
      font-size: 1.15rem;
    }
    .score {
      color: var(--accent);
      font-weight: 800;
    }

    .team-columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: var(--space-4);
    }
    .team-column {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .team-column h4 {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 1rem;
    }
    .badge-positive {
      background: var(--positive);
      color: #04150c;
      border-color: transparent;
    }
    .insight-group {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .positive-heading {
      color: var(--positive);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .negative-heading {
      color: var(--negative);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .insight-line {
      font-size: 0.85rem;
      line-height: 1.5;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      border-left: 3px solid transparent;
    }
    .insight-line.positive {
      background: rgba(53, 208, 127, 0.08);
      border-left-color: var(--positive);
    }
    .insight-line.negative {
      background: rgba(255, 82, 82, 0.08);
      border-left-color: var(--negative);
    }
  `,
})
export class GameInsightsComponent implements OnInit {
  private readonly toast = inject(ToastService);

  protected readonly modeOptions = MODE_OPTIONS;
  protected readonly sides: Side[] = ['home', 'away'];

  protected readonly mode = signal<InsightsMode>('game');
  protected readonly loading = signal(false);

  // By game
  protected readonly gameSearch = signal('');
  protected readonly games = signal<GameListEntry[]>([]);
  protected readonly selectedGameId = signal<number | null>(null);
  protected readonly gameResult = signal<GameInsightsResult | null>(null);
  protected readonly filteredGames = computed(() => {
    const q = this.gameSearch().trim().toLowerCase();
    const all = this.games();
    if (!q) return all;
    return all.filter(
      (g) => g.homeTeamName.toLowerCase().includes(q) || g.awayTeamName.toLowerCase().includes(q)
    );
  });

  // By team
  protected readonly teamSearch = signal('');
  protected readonly teams = signal<Team[]>([]);
  protected readonly selectedTeamId = signal<number | null>(null);
  protected readonly teamReport = signal<TeamScoutingReport | null>(null);
  protected readonly filteredTeams = computed(() => {
    const q = this.teamSearch().trim().toLowerCase();
    const all = this.teams();
    if (!q) return all;
    return all.filter((t) => t.name.toLowerCase().includes(q));
  });

  // By player
  protected readonly playerSearch = signal('');
  protected readonly players = signal<PlayerListEntry[]>([]);
  protected readonly selectedPlayerId = signal<number | null>(null);
  protected readonly playerReport = signal<PlayerScoutingReport | null>(null);
  protected readonly filteredPlayers = computed(() => {
    const q = this.playerSearch().trim().toLowerCase();
    const all = this.players();
    if (!q) return all;
    return all.filter((p) => p.name.toLowerCase().includes(q));
  });

  async ngOnInit(): Promise<void> {
    const [games, teams, players] = await Promise.all([
      window.boxscoreApi.listGames(),
      window.boxscoreApi.listTeams(),
      window.boxscoreApi.listAllPlayers(),
    ]);
    this.games.set(games);
    this.teams.set(teams);
    this.players.set(players);
  }

  protected setMode(mode: InsightsMode): void {
    this.mode.set(mode);
  }

  protected async selectGame(gameId: number): Promise<void> {
    this.selectedGameId.set(gameId);
    this.gameResult.set(null);
    this.loading.set(true);
    try {
      this.gameResult.set(await window.boxscoreApi.getGameInsights(gameId));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load game insights.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async selectTeam(teamId: number): Promise<void> {
    this.selectedTeamId.set(teamId);
    this.teamReport.set(null);
    this.loading.set(true);
    try {
      this.teamReport.set(await window.boxscoreApi.getTeamScoutingReport(teamId));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load the team report.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async selectPlayer(playerId: number): Promise<void> {
    this.selectedPlayerId.set(playerId);
    this.playerReport.set(null);
    this.loading.set(true);
    try {
      this.playerReport.set(await window.boxscoreApi.getPlayerScoutingReport(playerId));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load the player report.');
    } finally {
      this.loading.set(false);
    }
  }

  protected positivesFor(r: GameInsightsResult, side: Side): GameInsight[] {
    return r.insights.filter((i) => i.team === side && i.polarity === 'positive');
  }

  protected negativesFor(r: GameInsightsResult, side: Side): GameInsight[] {
    return r.insights.filter((i) => i.team === side && i.polarity === 'negative');
  }

  protected strengthsOf<T extends { polarity: 'strength' | 'weakness' }>(insights: T[]): T[] {
    return insights.filter((i) => i.polarity === 'strength');
  }

  protected weaknessesOf<T extends { polarity: 'strength' | 'weakness' }>(insights: T[]): T[] {
    return insights.filter((i) => i.polarity === 'weakness');
  }

  protected numFmt(n: number): string {
    return n.toFixed(1);
  }

  protected pctFmt(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
  }
}
