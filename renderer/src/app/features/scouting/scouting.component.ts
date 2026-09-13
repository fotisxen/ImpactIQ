import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { EntitiesService } from '../../core/data/entities.service';
import {
  AdvancedStatLine,
  CloudPlayer,
  League,
  PublishedReport,
  ReportViewer,
  ScoutingReport,
  ScoutingReportPlayerNote,
  ScoutingReportRecord,
  ScoutingTeamStatsRow,
  Season,
  ShotEvent,
  ShotZoneChart,
  Team,
} from '../../core/models/box-score.model';
import { EntityPickerComponent, PickerOption } from '../../shared/components/entity-picker.component';
import { LeaguePickerComponent } from '../../shared/components/league-picker.component';
import { ShotChartComponent } from '../../shared/components/shot-chart.component';
import { ShotZoneChartComponent } from '../../shared/components/shot-zone-chart.component';
import { formatPlayerName } from '../../shared/utils/format-player-name';
import { formatMinutesClock } from '../../shared/utils/format-minutes';
import { ToastService } from '../../shared/services/toast.service';

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

@Component({
  selector: 'app-scouting',
  standalone: true,
  imports: [FormsModule, DatePipe, EntityPickerComponent, LeaguePickerComponent, ShotChartComponent, ShotZoneChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="scouting-page">
      <header class="page-header">
        <h2>Scouting</h2>
        <p class="hint">Build a scouting report on your next opponent — dynamic, saved as you go, exportable to PDF.</p>
      </header>

      <div class="picker-row card">
        <app-league-picker
          [leagues]="leagues()"
          [selectedLeagueId]="selectedLeagueId()"
          [allowCreate]="false"
          (selectedLeagueIdChange)="selectLeague($event)"
        />
        @if (seasons().length > 0) {
          <app-entity-picker
            label="Season"
            [options]="seasonOptions()"
            [selectedId]="selectedSeasonId()"
            [allowCreate]="false"
            (selectedIdChange)="selectSeason($event)"
          />
        }
        <app-entity-picker
          label="My Team"
          [options]="teamOptions()"
          [selectedId]="selectedOurTeamId()"
          [allowCreate]="false"
          (selectedIdChange)="selectOurTeam($event)"
        />
        <app-entity-picker
          label="Opponent"
          [options]="opponentOptions()"
          [selectedId]="selectedOpponentTeamId()"
          [allowCreate]="false"
          (selectedIdChange)="selectOpponentTeam($event)"
        />
        <label class="field">
          <span class="field-label">Game date</span>
          <input type="date" [ngModel]="gameDate()" (ngModelChange)="onGameDateChange($event)" />
        </label>
        @if (reportRecord()) {
          <button type="button" class="btn btn-secondary btn-sm" [disabled]="exporting()" (click)="exportPdf()">
            {{ exporting() ? 'Exporting…' : 'Export PDF' }}
          </button>
          <button type="button" class="btn btn-primary btn-sm" [disabled]="publishing()" (click)="publishToTeam()">
            {{ publishing() ? 'Publishing…' : 'Publish to Team' }}
          </button>
        }
        <button type="button" class="btn btn-ghost btn-sm" (click)="toggleTeamPanel()">
          {{ showTeamPanel() ? 'Hide Team Panel' : 'Team Panel' }}
        </button>
      </div>

      @if (showTeamPanel()) {
        <div class="table-card card">
          <h4>Current Published Report</h4>
          @if (currentPublishedReport(); as pr) {
            <p class="hint">
              {{ pr.opponent_name || 'Report' }} · {{ pr.game_date }} · published {{ pr.published_at | date: 'short' }}
              <button type="button" class="btn btn-ghost btn-sm" (click)="refreshViewers()">Refresh viewers</button>
            </p>
          } @else {
            <p class="hint">Nothing published yet for your team.</p>
          }
          <ul class="bullet-list">
            @for (s of playerViewStatus(); track s.player.id) {
              <li>
                <span>
                  {{ s.player.first_name }} {{ s.player.last_name }} ({{ s.player.email }})
                  @if (currentPublishedReport()) {
                    —
                    @if (s.view) {
                      <strong class="seen">Seen</strong> {{ s.view.viewedAt | date: 'short' }}
                    } @else {
                      <span class="not-seen">Not seen yet</span>
                    }
                  }
                </span>
              </li>
            } @empty {
              <p class="hint">No player accounts yet.</p>
            }
          </ul>

          <h4>Add a Player</h4>
          <div class="add-row">
            <input type="text" placeholder="First name" [(ngModel)]="newPlayerFirstName" />
            <input type="text" placeholder="Last name" [(ngModel)]="newPlayerLastName" />
            <input type="email" placeholder="Email" [(ngModel)]="newPlayerEmail" />
            <button type="button" class="btn btn-secondary btn-sm" [disabled]="addingPlayer()" (click)="addPlayer()">
              {{ addingPlayer() ? 'Adding…' : 'Add Player' }}
            </button>
          </div>
          @if (newPlayerCredentials(); as cred) {
            <p class="hint">Give these to the player — shown once: <strong>{{ cred.email }}</strong> / <strong>{{ cred.password }}</strong></p>
          }
        </div>
      }

      @if (loading()) {
        <p class="hint">Loading…</p>
      }

      @if (!loading() && report(); as r) {
        <div class="matchup-header card">
          <h3>{{ r.ourTeamName }} vs. {{ r.opponentTeamName }}</h3>
          <p class="hint">{{ r.gameDate }} · {{ r.seasonYear }} · {{ r.opponentTeamName }} record {{ r.record.wins }}-{{ r.record.losses }}</p>
        </div>

        <div class="table-card card">
          <h4>Keys to the Game</h4>
          <ul class="bullet-list">
            @for (k of reportRecord()?.keysToGame ?? []; track $index) {
              <li>
                <span>{{ k }}</span>
                <button type="button" class="btn btn-ghost btn-sm" (click)="removeKey($index)">✕</button>
              </li>
            } @empty {
              <p class="hint">No keys added yet.</p>
            }
          </ul>
          <div class="add-row">
            <input type="text" placeholder="Add a key point…" [(ngModel)]="newKeyText" (keydown.enter)="addKey()" />
            <button type="button" class="btn btn-secondary btn-sm" (click)="addKey()">Add</button>
          </div>
        </div>

        <div class="table-card card">
          <h4>Cumulative Boxscore — {{ r.opponentTeamName }}</h4>
          <p class="hint">Hide a player (e.g. one who's young and doesn't play) to leave them out of the Depth Chart and Player Pages below — their real games still count in every team total.</p>
          <div class="table-scroll">
            <table class="scouting-table">
              <thead>
                <tr>
                  <th class="col-name">Player</th><th>Pos</th><th>GP</th><th>MIN</th><th>PTS</th><th>FGM-A</th><th>FG%</th>
                  <th>3PM-A</th><th>3P%</th><th>FTM-A</th><th>FT%</th><th>OREB</th><th>DREB</th><th>REB</th>
                  <th>AST</th><th>TOV</th><th>STL</th><th>BLK</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (p of r.roster; track p.playerId) {
                  <tr [class.hidden-row]="p.hidden">
                    <td class="col-name">{{ fmtName(p.name) }}</td>
                    <td>
                      <select (change)="onPositionChange(p.playerId, $event)">
                        <option value="" [selected]="!p.position">—</option>
                        @for (pos of positions; track pos) {
                          <option [value]="pos" [selected]="pos === p.position">{{ pos }}</option>
                        }
                      </select>
                    </td>
                    <td>{{ p.games }}</td>
                    <td>{{ min(p.perGame['min']) }}</td>
                    <td>{{ num(p.perGame['pts']) }}</td>
                    <td>{{ num(p.totals['fgm'], 0) }}-{{ num(p.totals['fga'], 0) }}</td>
                    <td>{{ pct(safeDiv(p.totals['fgm'], p.totals['fga'])) }}</td>
                    <td>{{ num(p.totals['tpm'], 0) }}-{{ num(p.totals['tpa'], 0) }}</td>
                    <td>{{ pct(safeDiv(p.totals['tpm'], p.totals['tpa'])) }}</td>
                    <td>{{ num(p.totals['ftm'], 0) }}-{{ num(p.totals['fta'], 0) }}</td>
                    <td>{{ pct(safeDiv(p.totals['ftm'], p.totals['fta'])) }}</td>
                    <td>{{ num(p.perGame['oreb']) }}</td>
                    <td>{{ num(p.perGame['dreb']) }}</td>
                    <td>{{ num((p.perGame['oreb'] ?? 0) + (p.perGame['dreb'] ?? 0)) }}</td>
                    <td>{{ num(p.perGame['ast']) }}</td>
                    <td>{{ num(p.perGame['tov']) }}</td>
                    <td>{{ num(p.perGame['stl']) }}</td>
                    <td>{{ num(p.perGame['blk']) }}</td>
                    <td>
                      <button type="button" class="btn btn-ghost btn-sm" (click)="toggleHidden(p.playerId, !p.hidden)" [title]="p.hidden ? 'Unhide — include in depth chart and player pages' : 'Hide — exclude from depth chart and player pages (e.g. a young player who never plays)'">
                        {{ p.hidden ? 'Unhide' : 'Hide' }}
                      </button>
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="19" class="hint">No roster data for this season.</td></tr>
                }
                <tr class="totals-row">
                  <td class="col-name">Team Total</td><td></td><td>{{ r.roster[0]?.games ?? 0 }}</td>
                  <td>—</td><td>{{ num(r.teamTotalsPerGame['pts']) }}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
                  <td>{{ num(r.teamTotalsPerGame['oreb']) }}</td><td>{{ num(r.teamTotalsPerGame['dreb']) }}</td>
                  <td>{{ num((r.teamTotalsPerGame['oreb'] ?? 0) + (r.teamTotalsPerGame['dreb'] ?? 0)) }}</td>
                  <td>{{ num(r.teamTotalsPerGame['ast']) }}</td><td>{{ num(r.teamTotalsPerGame['tov']) }}</td>
                  <td>{{ num(r.teamTotalsPerGame['stl']) }}</td><td>{{ num(r.teamTotalsPerGame['blk']) }}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="table-card card">
          <h4>Depth Chart</h4>
          <p class="hint">Set each player's position above, then use the arrows to order the depth chart within that position.</p>
          <div class="depth-grid">
            @for (d of r.depthChart; track d.position) {
              <div class="depth-col">
                <h5>{{ posLabel(d.position) }}</h5>
                @for (p of d.players; track p.playerId; let i = $index) {
                  <div class="depth-row">
                    <span>{{ fmtName(p.name) }}</span>
                    <span class="depth-arrows">
                      <button type="button" class="btn btn-ghost btn-sm" [disabled]="i === 0" (click)="moveDepth(d.position, i, -1)">↑</button>
                      <button type="button" class="btn btn-ghost btn-sm" [disabled]="i === d.players.length - 1" (click)="moveDepth(d.position, i, 1)">↓</button>
                    </span>
                  </div>
                } @empty {
                  <p class="hint">No players set to this position yet.</p>
                }
              </div>
            }
          </div>
        </div>

        <div class="table-card card">
          <h4>Recent Games — {{ r.opponentTeamName }}</h4>
          <div class="table-scroll">
            <table class="scouting-table">
              <thead><tr><th class="col-name">Date</th><th>Opponent</th><th>Site</th><th>Result</th><th>Score</th></tr></thead>
              <tbody>
                @for (g of r.recentGames; track g.date) {
                  <tr>
                    <td class="col-name">{{ g.date }}</td>
                    <td>{{ g.opponent }}</td>
                    <td>{{ g.site }}</td>
                    <td>{{ g.won ? 'W' : 'L' }}</td>
                    <td>{{ g.score }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="hint">No games yet.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <div class="table-card card">
          <h4>Impact IQ Factors</h4>
          <div class="table-scroll">
            <table class="scouting-table">
              <thead><tr><th class="col-name"></th><th>eFG%</th><th>TS%</th><th>TOV%</th><th>AST%</th><th>REB%</th><th>FT-R</th><th>FT%</th></tr></thead>
              <tbody>
                <tr><td class="col-name">{{ r.ourTeamName }} Off</td><td>{{ pct(r.impactIqFactors.us.off.efgPct) }}</td><td>{{ pct(r.impactIqFactors.us.off.tsPct) }}</td><td>{{ pct(r.impactIqFactors.us.off.tovPct) }}</td><td>{{ pct(r.impactIqFactors.us.off.astPct) }}</td><td>{{ pct(r.impactIqFactors.us.off.trebPct) }}</td><td>{{ pct(r.impactIqFactors.us.off.ftRate) }}</td><td>{{ pct(r.impactIqFactors.us.off.ftPct) }}</td></tr>
                <tr><td class="col-name">{{ r.ourTeamName }} Def</td><td>{{ pct(r.impactIqFactors.us.def.efgPct) }}</td><td>{{ pct(r.impactIqFactors.us.def.tsPct) }}</td><td>{{ pct(r.impactIqFactors.us.def.tovPct) }}</td><td>{{ pct(r.impactIqFactors.us.def.astPct) }}</td><td>{{ pct(r.impactIqFactors.us.def.trebPct) }}</td><td>{{ pct(r.impactIqFactors.us.def.ftRate) }}</td><td>{{ pct(r.impactIqFactors.us.def.ftPct) }}</td></tr>
                <tr><td class="col-name">{{ r.opponentTeamName }} Off</td><td>{{ pct(r.impactIqFactors.opponent.off.efgPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.off.tsPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.off.tovPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.off.astPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.off.trebPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.off.ftRate) }}</td><td>{{ pct(r.impactIqFactors.opponent.off.ftPct) }}</td></tr>
                <tr><td class="col-name">{{ r.opponentTeamName }} Def</td><td>{{ pct(r.impactIqFactors.opponent.def.efgPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.def.tsPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.def.tovPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.def.astPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.def.trebPct) }}</td><td>{{ pct(r.impactIqFactors.opponent.def.ftRate) }}</td><td>{{ pct(r.impactIqFactors.opponent.def.ftPct) }}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="table-card card">
          <h4>Team Stats — {{ r.opponentTeamName }}</h4>
          <div class="table-scroll">
            <table class="scouting-table">
              <thead>
                <tr><th class="col-name">Split</th><th>PTS</th><th>FGM-A</th><th>FG%</th><th>3PM-A</th><th>3P%</th><th>FTM-A</th><th>FT%</th><th>AST</th><th>REB</th><th>STL</th><th>BLK</th><th>TOV</th><th>PACE</th><th>ORTG</th><th>DRTG</th><th>PPP</th><th>Off TO Pts</th><th>2nd Chance Pts</th><th>Fastbreak Pts</th><th>Pts in Paint</th></tr>
              </thead>
              <tbody>
                @for (row of teamStatsRows(r); track row.label) {
                  <tr>
                    <td class="col-name">{{ row.label }}</td>
                    <td>{{ num(row.stats.pts) }}</td>
                    <td>{{ num(row.stats.fgm, 0) }}-{{ num(row.stats.fga, 0) }}</td>
                    <td>{{ pct(row.stats.fgPct) }}</td>
                    <td>{{ num(row.stats.tpm, 0) }}-{{ num(row.stats.tpa, 0) }}</td>
                    <td>{{ pct(row.stats.tpPct) }}</td>
                    <td>{{ num(row.stats.ftm, 0) }}-{{ num(row.stats.fta, 0) }}</td>
                    <td>{{ pct(row.stats.ftPct) }}</td>
                    <td>{{ num(row.stats.ast) }}</td>
                    <td>{{ num(row.stats.reb) }}</td>
                    <td>{{ num(row.stats.stl) }}</td>
                    <td>{{ num(row.stats.blk) }}</td>
                    <td>{{ num(row.stats.tov) }}</td>
                    <td>{{ num(row.stats.pace) }}</td>
                    <td>{{ num(row.stats.ortg, 2) }}</td>
                    <td>{{ num(row.stats.drtg, 2) }}</td>
                    <td>{{ num(row.stats.ppp, 2) }}</td>
                    <td>{{ num(row.stats.pointsOffTurnovers) }}</td>
                    <td>{{ num(row.stats.secondChancePoints) }}</td>
                    <td>{{ num(row.stats.fastbreakPoints) }}</td>
                    <td>{{ num(row.stats.pointsInThePaint) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (teamStatsRows(r)[0]?.stats?.advancedStatsAreOfficial) {
            <p class="hint">Off TO Pts / 2nd Chance / Fastbreak / Pts in Paint are official numbers from the imported data source's own per-shot tagging, not an estimate.</p>
          } @else {
            <p class="hint">Off TO Pts / 2nd Chance / Fastbreak are the app's own estimate reconstructed from play-by-play (Fastbreak uses an 8-second-since-gaining-the-ball threshold — treat it as directional, not exact). Points in the Paint stays N/A until shot-location or official per-game data is imported.</p>
          }
        </div>

        @if (r.pointsPerPeriod; as ppp) {
          <div class="table-card card">
            <h4>Points Per Period — {{ r.opponentTeamName }}</h4>
            <div class="table-scroll">
              <table class="scouting-table">
                <thead><tr><th class="col-name"></th><th>1st</th><th>2nd</th><th>3rd</th><th>4th+OT</th><th>Game</th></tr></thead>
                <tbody>
                  <tr><td class="col-name">{{ r.opponentTeamName }}</td>@for (v of ppp.team; track $index) {<td>{{ num(v) }}</td>}<td>{{ num(sum(ppp.team)) }}</td></tr>
                  <tr><td class="col-name">Opponents</td>@for (v of ppp.opponent; track $index) {<td>{{ num(v) }}</td>}<td>{{ num(sum(ppp.opponent)) }}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        }

        <div class="table-card card">
          <h4>Team Pace &amp; Advanced Stats — {{ r.opponentTeamName }}</h4>
          <div class="table-scroll">
            <table class="scouting-table">
              <thead><tr><th class="col-name">W-L</th><th>PW%</th><th>ORTG</th><th>DRTG</th><th>NRTG</th><th>PACE</th><th>FT-R</th><th>3P-R</th><th>Poss</th></tr></thead>
              <tbody>
                <tr>
                  <td class="col-name">{{ r.advStatsRow.wins }}-{{ r.advStatsRow.losses }}</td>
                  <td>{{ pct(r.advStatsRow.pythagoreanWinPct) }}</td>
                  <td>{{ num(r.advStatsRow.ortg, 2) }}</td>
                  <td>{{ num(r.advStatsRow.drtg, 2) }}</td>
                  <td>{{ num(r.advStatsRow.netRating, 2) }}</td>
                  <td>{{ num(r.advStatsRow.pace) }}</td>
                  <td>{{ pct(r.advStatsRow.ftRate) }}</td>
                  <td>{{ pct(r.advStatsRow.threePtRate) }}</td>
                  <td>{{ num(r.advStatsRow.possessions) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="hint">Team Pace — {{ r.ourTeamName }}: {{ num(r.teamPace.us) }} poss/game · {{ r.opponentTeamName }}: {{ num(r.teamPace.opponent) }} poss/game.</p>
        </div>

        <div class="table-card card">
          <h4>Shooting By Zone — {{ r.opponentTeamName }}</h4>
          @if (teamShotEvents() && teamShotEvents()!.length > 0) {
            <app-shot-chart [shots]="teamShotEvents()" />
          } @else {
            <app-shot-zone-chart [data]="teamShotZones()" />
          }
        </div>

        <div class="leaders-grid">
          <div class="table-card card">
            <h5>Top Scorers</h5>
            @for (p of r.leaders.topScorers; track p.playerId) { <p class="leader-row"><span>{{ fmtName(p.name) }}</span><span>{{ num(asNum(p['value'])) }}</span></p> }
          </div>
          <div class="table-card card">
            <h5>3PT Shooters</h5>
            @for (p of r.leaders.threePtShooters; track p.playerId) { <p class="leader-row"><span>{{ fmtName(p.name) }}</span><span>{{ p['tpm'] }}-{{ p['tpa'] }} ({{ pct(asNum(p['tpPct'])) }})</span></p> }
          </div>
          <div class="table-card card">
            <h5>FT Shooters</h5>
            @for (p of r.leaders.ftShooters; track p.playerId) { <p class="leader-row"><span>{{ fmtName(p.name) }}</span><span>{{ p['ftm'] }}-{{ p['fta'] }} ({{ pct(asNum(p['ftPct'])) }})</span></p> }
          </div>
          <div class="table-card card">
            <h5>Top Rebounders</h5>
            @for (p of r.leaders.topRebounders; track p.playerId) { <p class="leader-row"><span>{{ fmtName(p.name) }}</span><span>{{ p['reb'] }} ({{ p['oreb'] }} OREB)</span></p> }
          </div>
          <div class="table-card card">
            <h5>Ball Control</h5>
            @for (p of r.leaders.ballControl; track p.playerId) { <p class="leader-row"><span>{{ fmtName(p.name) }}</span><span>{{ p['ast'] }} AST / {{ p['tov'] }} TOV</span></p> }
          </div>
          <div class="table-card card">
            <h5>Defense</h5>
            @for (p of r.leaders.defense; track p.playerId) { <p class="leader-row"><span>{{ fmtName(p.name) }}</span><span>{{ num(asNum(p['stl'])) }} STL / {{ num(asNum(p['blk'])) }} BLK</span></p> }
          </div>
        </div>

        <h3 class="section-title">Player Pages — {{ r.opponentTeamName }}</h3>
        @for (p of r.playerPages; track p.playerId) {
          <div class="table-card card player-page">
            <div class="player-page-header">
              <div>
                <h4>{{ fmtName(p.name) }}</h4>
                <p class="hint">{{ p.position || '—' }} · {{ p.height || 'Height not set' }}</p>
              </div>
              <div class="photo-block">
                @if (photoFor(p.playerId); as photo) {
                  <img [src]="photo" class="player-photo" alt="" />
                }
                <input type="file" accept="image/*" (change)="onPhotoSelected(p.playerId, $event)" />
              </div>
            </div>

            <div class="table-scroll">
              <table class="scouting-table">
                <thead><tr><th class="col-name"></th><th>PTS</th><th>MIN</th><th>REB</th><th>AST</th><th>eFG%</th></tr></thead>
                <tbody>
                  <tr><td class="col-name">Season</td><td>{{ num(p.perGame['pts']) }}</td><td>{{ min(p.perGame['min']) }}</td><td>{{ num((p.perGame['oreb'] ?? 0) + (p.perGame['dreb'] ?? 0)) }}</td><td>{{ num(p.perGame['ast']) }}</td><td>{{ pct(p.advanced.efg_pct) }}</td></tr>
                  @for (m of p.meetings; track m.date) {
                    <tr><td class="col-name">{{ m.date }} {{ m.site }}</td><td>{{ num(m.perGame['pts']) }}</td><td>{{ min(m.perGame['min']) }}</td><td>{{ num((m.perGame['oreb'] ?? 0) + (m.perGame['dreb'] ?? 0)) }}</td><td>{{ num(m.perGame['ast']) }}</td><td>{{ pct(m.advanced.efg_pct) }}</td></tr>
                  }
                </tbody>
              </table>
            </div>

            @if ((playerShotEvents().get(p.playerId) ?? []).length > 0) {
              <app-shot-chart [shots]="playerShotEvents().get(p.playerId) ?? null" />
            } @else {
              <app-shot-zone-chart [data]="playerShotZones().get(p.playerId) ?? null" />
            }

            <div class="notes-block">
              <h5>How to guard {{ fmtName(p.name) }}</h5>
              <ul class="bullet-list">
                @for (n of notesFor(p.playerId); track $index) {
                  <li><span>{{ n }}</span><button type="button" class="btn btn-ghost btn-sm" (click)="removeNote(p.playerId, $index)">✕</button></li>
                } @empty {
                  <p class="hint">No notes yet.</p>
                }
              </ul>
              <div class="add-row">
                <input type="text" placeholder="Add a note…" [(ngModel)]="newNoteText[p.playerId]" (keydown.enter)="addNote(p.playerId)" />
                <button type="button" class="btn btn-secondary btn-sm" (click)="addNote(p.playerId)">Add</button>
              </div>
            </div>
          </div>
        }
      } @else if (!loading() && selectedOurTeamId() !== null && selectedOpponentTeamId() !== null) {
        <p class="hint">Pick a season and game date to build the report.</p>
      }
    </section>
  `,
  styles: `
    .scouting-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      padding: var(--space-6);
      max-width: 1300px;
    }
    .page-header h2 { font-size: 1.4rem; }
    .picker-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: var(--space-4);
      align-items: end;
    }
    .picker-row app-league-picker { grid-column: span 2; min-width: 340px; }
    .field { display: flex; flex-direction: column; gap: var(--space-1); }
    .field-label { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .field input[type="date"] {
      background: var(--surface-raised); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3); color: var(--text);
    }
    .matchup-header h3 { font-size: 1.2rem; }
    .table-card { display: flex; flex-direction: column; gap: var(--space-3); }
    .table-card h4 { font-size: 0.95rem; }
    .table-scroll { overflow-x: auto; }
    .scouting-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; white-space: nowrap; }
    .scouting-table th, .scouting-table td { padding: var(--space-2); text-align: right; border-bottom: 1px solid var(--border); }
    .scouting-table .col-name { text-align: left; font-weight: 600; }
    .scouting-table .totals-row td { font-weight: 700; border-top: 2px solid var(--border-strong); }
    .scouting-table .hidden-row td { opacity: 0.45; }
    .seen { color: var(--positive); }
    .not-seen { color: var(--text-muted); }
    .bullet-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-1); }
    .bullet-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-1) 0; }
    .bullet-list li > span:first-child::before { content: '•'; color: var(--accent); margin-right: var(--space-2); font-weight: 700; }
    .add-row { display: flex; gap: var(--space-2); align-items: center; }
    .add-row input[type="text"] {
      flex: 1; background: var(--surface-raised); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3); color: var(--text);
    }
    .depth-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--space-3); }
    .depth-col { display: flex; flex-direction: column; gap: var(--space-2); }
    .depth-col h5 { font-size: 0.8rem; text-transform: uppercase; color: var(--text-muted); }
    .depth-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); font-size: 0.85rem; }
    .depth-arrows { display: flex; gap: 2px; }
    .leaders-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
    .leader-row { display: flex; justify-content: space-between; gap: var(--space-3); font-size: 0.85rem; margin: var(--space-1) 0; }
    .section-title { font-size: 1.1rem; margin-top: var(--space-3); }
    .player-page { gap: var(--space-4); }
    .player-page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); }
    .photo-block { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-end; }
    .player-photo { width: 96px; height: 96px; object-fit: cover; border-radius: var(--radius-md); border: 1px solid var(--border); }
    .notes-block { display: flex; flex-direction: column; gap: var(--space-2); }
  `,
})
export class ScoutingComponent implements OnInit {
  private readonly entities = inject(EntitiesService);
  private readonly toast = inject(ToastService);

  protected readonly positions = POSITIONS;

  protected readonly leagues = signal<League[]>([]);
  protected readonly teams = signal<Team[]>([]);
  protected readonly seasons = signal<Season[]>([]);
  protected readonly selectedLeagueId = signal<number | null>(null);
  protected readonly selectedSeasonId = signal<number | null>(null);
  protected readonly selectedOurTeamId = signal<number | null>(null);
  protected readonly selectedOpponentTeamId = signal<number | null>(null);
  protected readonly gameDate = signal<string>('');

  protected readonly loading = signal(false);
  protected readonly exporting = signal(false);
  protected readonly publishing = signal(false);
  protected readonly showTeamPanel = signal(false);
  protected readonly currentPublishedReport = signal<PublishedReport | null>(null);
  protected readonly reportViewers = signal<ReportViewer[]>([]);
  protected readonly cloudPlayers = signal<CloudPlayer[]>([]);
  /** Every player account, each paired with whether/when they've opened the current report — so a coach sees the whole roster, not just who bothered to open it. */
  protected readonly playerViewStatus = computed(() => {
    const viewedById = new Map(this.reportViewers().map((v) => [v.viewerId, v]));
    return this.cloudPlayers().map((p) => ({ player: p, view: viewedById.get(p.id) ?? null }));
  });
  protected readonly addingPlayer = signal(false);
  protected readonly newPlayerCredentials = signal<{ email: string; password: string } | null>(null);
  protected newPlayerFirstName = '';
  protected newPlayerLastName = '';
  protected newPlayerEmail = '';
  protected readonly report = signal<ScoutingReport | null>(null);
  protected readonly reportRecord = signal<ScoutingReportRecord | null>(null);
  protected readonly playerNotes = signal<ScoutingReportPlayerNote[]>([]);
  protected readonly teamShotZones = signal<ShotZoneChart | null>(null);
  protected readonly playerShotZones = signal<Map<number, ShotZoneChart>>(new Map());
  protected readonly teamShotEvents = signal<ShotEvent[] | null>(null);
  protected readonly playerShotEvents = signal<Map<number, ShotEvent[]>>(new Map());

  protected newKeyText = '';
  protected readonly newNoteText: Record<number, string> = {};

  protected readonly teamOptions = computed<PickerOption[]>(() => {
    const leagueId = this.selectedLeagueId();
    if (leagueId === null) return [];
    return this.teams().filter((t) => t.league_id === leagueId).map((t) => ({ id: t.id, label: t.name }));
  });
  protected readonly opponentOptions = computed<PickerOption[]>(() =>
    this.teamOptions().filter((o) => o.id !== this.selectedOurTeamId())
  );
  protected readonly seasonOptions = computed<PickerOption[]>(() => this.seasons().map((s) => ({ id: s.id, label: s.year })));

  async ngOnInit(): Promise<void> {
    const [leagues, teams, favorite] = await Promise.all([
      this.entities.listLeagues(),
      this.entities.listTeams(),
      window.boxscoreApi.getFavoriteTeam(),
    ]);
    this.leagues.set(leagues);
    this.teams.set(teams);
    this.gameDate.set(new Date().toISOString().slice(0, 10));
    if (favorite) {
      this.selectedLeagueId.set(favorite.league_id);
      this.selectedOurTeamId.set(favorite.id);
      const seasons = await this.entities.listSeasons(favorite.league_id);
      this.seasons.set(seasons);
      this.selectedSeasonId.set(seasons[0]?.id ?? null);
    }
  }

  protected async selectLeague(leagueId: number | null): Promise<void> {
    this.selectedLeagueId.set(leagueId);
    this.selectedOurTeamId.set(null);
    this.selectedOpponentTeamId.set(null);
    this.report.set(null);
    if (leagueId === null) {
      this.seasons.set([]);
      this.selectedSeasonId.set(null);
      return;
    }
    const seasons = await this.entities.listSeasons(leagueId);
    this.seasons.set(seasons);
    this.selectedSeasonId.set(seasons[0]?.id ?? null);
  }

  protected selectSeason(seasonId: number | null): void {
    this.selectedSeasonId.set(seasonId);
    void this.maybeLoadReport();
  }

  protected selectOurTeam(teamId: number | null): void {
    this.selectedOurTeamId.set(teamId);
    void this.maybeLoadReport();
  }

  protected selectOpponentTeam(teamId: number | null): void {
    this.selectedOpponentTeamId.set(teamId);
    void this.maybeLoadReport();
  }

  protected onGameDateChange(date: string): void {
    this.gameDate.set(date);
    void this.maybeLoadReport();
  }

  /**
   * `showLoading: false` is for quick in-place edits (position dropdown,
   * depth-chart reordering) — refetches the same data but never blanks the
   * already-rendered report out from under the coach's cursor/scroll
   * position while it does. Only a genuine matchup change (new team/
   * opponent/season/date) needs the spinner gate.
   */
  private async maybeLoadReport(showLoading = true): Promise<void> {
    const ourTeamId = this.selectedOurTeamId();
    const opponentTeamId = this.selectedOpponentTeamId();
    const seasonId = this.selectedSeasonId();
    const gameDate = this.gameDate();
    if (ourTeamId === null || opponentTeamId === null || seasonId === null || !gameDate) return;

    if (showLoading) this.loading.set(true);
    try {
      const [report, record] = await Promise.all([
        window.boxscoreApi.getScoutingReport(ourTeamId, opponentTeamId, seasonId, gameDate),
        window.boxscoreApi.getOrCreateScoutingReportRecord({ ourTeamId, opponentTeamId, seasonId, gameDate }),
      ]);
      this.report.set(report);
      this.reportRecord.set(record);
      this.playerNotes.set(await window.boxscoreApi.getScoutingReportPlayerNotes(record.id));
      if (report) {
        this.teamShotZones.set(await window.boxscoreApi.getTeamShotZones(report.opponentTeamId, report.seasonId));
        this.teamShotEvents.set(await window.boxscoreApi.getTeamShotEvents(report.opponentTeamId, report.seasonId));
        const zones = new Map<number, ShotZoneChart>();
        const events = new Map<number, ShotEvent[]>();
        await Promise.all(
          report.roster.map(async (p) => {
            zones.set(p.playerId, await window.boxscoreApi.getPlayerShotZones(p.playerId, report.seasonId));
            events.set(p.playerId, await window.boxscoreApi.getPlayerShotEvents(p.playerId, report.seasonId));
          })
        );
        this.playerShotZones.set(zones);
        this.playerShotEvents.set(events);
      }
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load the scouting report.');
    } finally {
      if (showLoading) this.loading.set(false);
    }
  }

  // --- Keys to the game ---
  protected addKey(): void {
    const text = this.newKeyText.trim();
    if (!text) return;
    const record = this.reportRecord();
    if (!record) return;
    const keys = [...record.keysToGame, text];
    this.reportRecord.set({ ...record, keysToGame: keys });
    this.newKeyText = '';
    void window.boxscoreApi.saveScoutingReportKeys(record.id, keys);
  }

  protected removeKey(index: number): void {
    const record = this.reportRecord();
    if (!record) return;
    const keys = record.keysToGame.filter((_, i) => i !== index);
    this.reportRecord.set({ ...record, keysToGame: keys });
    void window.boxscoreApi.saveScoutingReportKeys(record.id, keys);
  }

  // --- Position / depth chart ---
  protected async onPositionChange(playerId: number, event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value || null;
    await window.boxscoreApi.updatePlayerPosition(playerId, value);
    await this.maybeLoadReport(false);
  }

  protected async moveDepth(position: string, index: number, direction: -1 | 1): Promise<void> {
    const r = this.report();
    if (!r) return;
    const group = r.depthChart.find((d) => d.position === position);
    if (!group) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= group.players.length) return;
    const reordered = [...group.players];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    await Promise.all(reordered.map((p, i) => window.boxscoreApi.updatePlayerDepthRank(p.playerId, i)));
    await this.maybeLoadReport(false);
  }

  protected async toggleHidden(playerId: number, hidden: boolean): Promise<void> {
    await window.boxscoreApi.updatePlayerHidden(playerId, hidden);
    await this.maybeLoadReport(false);
  }

  protected posLabel(pos: string): string {
    const labels: Record<string, string> = { PG: 'Point Guard', SG: 'Shooting Guard', SF: 'Small Forward', PF: 'Power Forward', C: 'Center' };
    return labels[pos] ?? pos;
  }

  // --- Player notes ---
  protected notesFor(playerId: number): string[] {
    return this.playerNotes().find((n) => n.playerId === playerId)?.notes ?? [];
  }

  protected async addNote(playerId: number): Promise<void> {
    const text = (this.newNoteText[playerId] ?? '').trim();
    if (!text) return;
    const notes = [...this.notesFor(playerId), text];
    this.updateLocalNotes(playerId, notes);
    this.newNoteText[playerId] = '';
    const record = this.reportRecord();
    if (record) await window.boxscoreApi.saveScoutingReportPlayerNotes(record.id, playerId, notes);
  }

  protected async removeNote(playerId: number, index: number): Promise<void> {
    const notes = this.notesFor(playerId).filter((_, i) => i !== index);
    this.updateLocalNotes(playerId, notes);
    const record = this.reportRecord();
    if (record) await window.boxscoreApi.saveScoutingReportPlayerNotes(record.id, playerId, notes);
  }

  private updateLocalNotes(playerId: number, notes: string[]): void {
    const existing = this.playerNotes();
    const idx = existing.findIndex((n) => n.playerId === playerId);
    if (idx >= 0) {
      const copy = [...existing];
      copy[idx] = { ...copy[idx], notes };
      this.playerNotes.set(copy);
    } else {
      this.playerNotes.set([...existing, { playerId, notes, photoPath: null }]);
    }
  }

  protected photoFor(playerId: number): string | null {
    return this.playerNotes().find((n) => n.playerId === playerId)?.photoPath ?? null;
  }

  protected async onPhotoSelected(playerId: number, event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const existing = this.playerNotes();
    const idx = existing.findIndex((n) => n.playerId === playerId);
    if (idx >= 0) {
      const copy = [...existing];
      copy[idx] = { ...copy[idx], photoPath: dataUrl };
      this.playerNotes.set(copy);
    } else {
      this.playerNotes.set([...existing, { playerId, notes: [], photoPath: dataUrl }]);
    }
    const record = this.reportRecord();
    if (record) await window.boxscoreApi.saveScoutingReportPlayerPhoto(record.id, playerId, dataUrl);
  }

  // --- Export ---
  protected async exportPdf(): Promise<void> {
    const ourTeamId = this.selectedOurTeamId();
    const opponentTeamId = this.selectedOpponentTeamId();
    const seasonId = this.selectedSeasonId();
    const gameDate = this.gameDate();
    if (ourTeamId === null || opponentTeamId === null || seasonId === null || !gameDate) return;
    this.exporting.set(true);
    try {
      const result = await window.boxscoreApi.exportScoutingReportPdf({ ourTeamId, opponentTeamId, seasonId, gameDate });
      if (result.saved) this.toast.success('Scouting report exported.');
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to export the report.');
    } finally {
      this.exporting.set(false);
    }
  }

  // --- Publish to team (cloud) ---
  protected async toggleTeamPanel(): Promise<void> {
    const opening = !this.showTeamPanel();
    this.showTeamPanel.set(opening);
    if (opening) await this.loadTeamPanel();
  }

  protected async publishToTeam(): Promise<void> {
    const ourTeamId = this.selectedOurTeamId();
    const opponentTeamId = this.selectedOpponentTeamId();
    const seasonId = this.selectedSeasonId();
    const gameDate = this.gameDate();
    if (ourTeamId === null || opponentTeamId === null || seasonId === null || !gameDate) return;
    this.publishing.set(true);
    try {
      const result = await window.boxscoreApi.publishScoutingReport({ ourTeamId, opponentTeamId, seasonId, gameDate });
      if (result.published) {
        this.toast.success('Published to your team.');
        await this.loadTeamPanel();
      }
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to publish the report.');
    } finally {
      this.publishing.set(false);
    }
  }

  private async loadTeamPanel(): Promise<void> {
    try {
      const [current, players] = await Promise.all([
        window.boxscoreApi.getCurrentPublishedReport(),
        window.boxscoreApi.listCloudPlayers(),
      ]);
      this.currentPublishedReport.set(current);
      this.cloudPlayers.set(players);
      if (current) this.reportViewers.set(await window.boxscoreApi.listReportViewers(current.id));
      else this.reportViewers.set([]);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load the team panel.');
    }
  }

  protected async refreshViewers(): Promise<void> {
    const current = this.currentPublishedReport();
    if (!current) return;
    this.reportViewers.set(await window.boxscoreApi.listReportViewers(current.id));
  }

  protected async addPlayer(): Promise<void> {
    const firstName = this.newPlayerFirstName.trim();
    const lastName = this.newPlayerLastName.trim();
    const email = this.newPlayerEmail.trim();
    if (!firstName || !lastName || !email) return;
    this.addingPlayer.set(true);
    try {
      const creds = await window.boxscoreApi.createPlayerAccount({ firstName, lastName, email });
      this.newPlayerCredentials.set(creds);
      this.newPlayerFirstName = '';
      this.newPlayerLastName = '';
      this.newPlayerEmail = '';
      this.cloudPlayers.set(await window.boxscoreApi.listCloudPlayers());
      this.toast.success('Player account created.');
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to create the player account.');
    } finally {
      this.addingPlayer.set(false);
    }
  }

  // --- Formatting helpers ---
  protected fmtName(raw: string): string {
    return formatPlayerName(raw);
  }

  protected num(v: number | null | undefined, decimals = 1): string {
    return v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(decimals);
  }

  protected min(v: number | null | undefined): string {
    return v === null || v === undefined || Number.isNaN(v) ? '—' : formatMinutesClock(v);
  }

  protected pct(v: number | null | undefined): string {
    return v === null || v === undefined || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`;
  }

  protected safeDiv(a: number | undefined, b: number | undefined): number | null {
    if (!a || !b) return a === 0 && b ? 0 : null;
    return b === 0 ? null : a / b;
  }

  protected sum(values: number[]): number {
    return values.reduce((a, v) => a + v, 0);
  }

  protected asNum(v: unknown): number | null {
    return typeof v === 'number' ? v : null;
  }

  protected teamStatsRows(r: ScoutingReport): { label: string; stats: ScoutingTeamStatsRow }[] {
    const rows: { label: string; stats: ScoutingTeamStatsRow }[] = [];
    if (r.teamStats.allOff) rows.push({ label: 'All', stats: r.teamStats.allOff });
    if (r.teamStats.last5) rows.push({ label: 'Last 5', stats: r.teamStats.last5 });
    for (const m of r.teamStats.meetings) {
      if (m.stats) rows.push({ label: `${m.date} ${m.site} ${m.ourTeamName}`, stats: m.stats });
    }
    return rows;
  }
}
