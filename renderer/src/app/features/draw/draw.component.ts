import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EntityPickerComponent, PickerOption } from '../../shared/components/entity-picker.component';
import { ToastService } from '../../shared/services/toast.service';
import type { PlayData, PlayDrawing, PlayDrawingType, PlayFrame, PlaybookEntry } from '../../core/models/box-score.model';

type Tool = 'move' | 'move-arrow' | 'pass' | 'screen' | 'dribble' | 'text' | 'erase';

interface DragState {
  frameIndex: number;
  svg: SVGSVGElement;
  kind: 'player' | 'ball';
  playerId?: number;
}
interface DrawState {
  frameIndex: number;
  svg: SVGSVGElement;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const TOOL_TO_DRAWING_TYPE: Partial<Record<Tool, PlayDrawingType>> = {
  'move-arrow': 'move',
  pass: 'pass',
  screen: 'screen',
  dribble: 'dribble',
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function defaultFrame(): PlayFrame {
  return {
    players: [
      { id: 1, x: 150, y: 235 },
      { id: 2, x: 235, y: 175 },
      { id: 3, x: 65, y: 175 },
      { id: 4, x: 205, y: 55 },
      { id: 5, x: 95, y: 55 },
    ],
    ball: { x: 150, y: 250 },
    drawings: [],
  };
}

const SNAP_RADIUS = 25;
function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Where each player/the ball actually end up once this frame's drawn
 * movements happen — a 'move' or 'screen' arrow starting near a player
 * repositions them to the arrow's end; a 'dribble' arrow moves both that
 * player AND the ball together; a 'pass' arrow moves only the ball. Anything
 * not the start of a matching arrow just stays where it is. This is what the
 * next court's starting positions are seeded from, so "add court" actually
 * continues the play instead of duplicating the same frame.
 */
function applyMovements(f: PlayFrame): { players: { id: number; x: number; y: number }[]; ball: { x: number; y: number } } {
  const arrowFrom = (x: number, y: number, types: PlayDrawingType[]) =>
    f.drawings.find((d) => types.includes(d.type) && dist(d.x1, d.y1, x, y) <= SNAP_RADIUS);

  const players = f.players.map((p) => {
    const arrow = arrowFrom(p.x, p.y, ['move', 'screen', 'dribble']);
    return arrow ? { id: p.id, x: arrow.x2, y: arrow.y2 } : { ...p };
  });

  const dribbleFromBall = arrowFrom(f.ball.x, f.ball.y, ['dribble']);
  const passFromBall = arrowFrom(f.ball.x, f.ball.y, ['pass']);
  const ballArrow = dribbleFromBall ?? passFromBall;
  const ball = ballArrow ? { x: ballArrow.x2, y: ballArrow.y2 } : { ...f.ball };

  return { players, ball };
}

function cloneFrameForContinuation(f: PlayFrame): PlayFrame {
  const next = applyMovements(f);
  return {
    players: next.players,
    ball: next.ball,
    drawings: [],
  };
}

@Component({
  selector: 'app-draw',
  standalone: true,
  imports: [FormsModule, EntityPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <h2>Draw — Play Designer</h2>
      <p class="subtitle">Drag the 5 players and the ball into position, draw the movement, then add another court to continue the play.</p>

      <div class="toolbar card">
        <div class="toolbar-row">
          <app-entity-picker label="Team" [options]="teamOptions()" [selectedId]="selectedTeamId()" [allowCreate]="false" (selectedIdChange)="onTeamChange($event)" />
          <label class="field">
            <span class="field-label">Play name</span>
            <input class="text-input" [(ngModel)]="playName" placeholder="e.g. Horns Flare" />
          </label>
          <button class="btn btn-primary btn-sm" (click)="savePlay()" [disabled]="!playName().trim()">
            {{ currentPlayId() ? 'Update Play' : 'Save Play' }}
          </button>
          <button class="btn btn-ghost btn-sm" (click)="newPlay()">New Play</button>
          <button class="btn btn-ghost btn-sm" (click)="showPlaybook.set(!showPlaybook())">
            {{ showPlaybook() ? 'Hide Playbook' : 'Playbook (' + playbook().length + ')' }}
          </button>
          <button class="btn btn-primary btn-sm" (click)="playPlayback()" [disabled]="frames().length < 2">▶ Play</button>
        </div>

        <div class="toolbar-row">
          <span class="field-label">Tool</span>
          <div class="tool-group">
            <button class="tool-btn" [class.active]="tool() === 'move'" (click)="tool.set('move')" title="Move players/ball">✥ Move</button>
            <button class="tool-btn" [class.active]="tool() === 'move-arrow'" (click)="tool.set('move-arrow')" title="Draw a cut/movement">→ Cut</button>
            <button class="tool-btn" [class.active]="tool() === 'pass'" (click)="tool.set('pass')" title="Draw a pass">⇢ Pass</button>
            <button class="tool-btn" [class.active]="tool() === 'screen'" (click)="tool.set('screen')" title="Draw a screen">⊥ Screen</button>
            <button class="tool-btn" [class.active]="tool() === 'dribble'" (click)="tool.set('dribble')" title="Draw a dribble">〰 Dribble</button>
            <button class="tool-btn" [class.active]="tool() === 'text'" (click)="tool.set('text')" title="Add a text label">T Text</button>
            <button class="tool-btn" [class.active]="tool() === 'erase'" (click)="tool.set('erase')" title="Click a drawing to remove it">✕ Erase</button>
          </div>
          <button class="btn btn-ghost btn-sm" (click)="undo()" [disabled]="undoStack.length === 0">Undo</button>
          <button class="btn btn-ghost btn-sm" (click)="clearCurrentFrameDrawings()">Clear frame drawings</button>
        </div>
      </div>

      @if (showPlaybook()) {
        <div class="card playbook-card">
          <h4>Playbook{{ selectedTeamId() ? '' : ' (all teams)' }}</h4>
          @if (playbook().length === 0) {
            <p class="hint">No saved plays yet{{ selectedTeamId() ? ' for this team' : '' }}.</p>
          } @else {
            <ul class="playbook-list">
              @for (p of playbook(); track p.id) {
                <li>
                  <span class="play-name">{{ p.name }}</span>
                  <span class="play-updated">{{ p.updatedAt }}</span>
                  <button class="btn btn-ghost btn-sm" (click)="loadPlay(p.id)">Load</button>
                  <button class="btn btn-ghost btn-sm danger" (click)="deletePlay(p.id)">Delete</button>
                </li>
              }
            </ul>
          }
        </div>
      }

      <div class="frames-grid">
        @for (frame of frames(); track $index; let i = $index) {
          <div class="frame-card">
            <div class="frame-header">
              <span>Frame {{ i + 1 }}</span>
              @if (frames().length > 1) {
                <button class="frame-remove" (click)="removeFrame(i)" title="Remove this frame">✕</button>
              }
            </div>
            <svg
              #courtSvg
              viewBox="0 0 300 320"
              class="court"
              [class.tool-draw]="tool() !== 'move' && tool() !== 'erase'"
              [class.tool-erase]="tool() === 'erase'"
              (pointerdown)="onCourtPointerDown($event, i, $any(courtSvg))"
            >
              <defs>
                <marker id="arrow-move" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" class="marker-move" /></marker>
                <marker id="arrow-pass" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" class="marker-pass" /></marker>
                <marker id="arrow-dribble" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" class="marker-dribble" /></marker>
                <marker id="screen-tick" markerWidth="8" markerHeight="12" refX="4" refY="6" orient="auto"><line x1="4" y1="0" x2="4" y2="12" class="marker-screen" /></marker>
              </defs>

              <rect x="0" y="0" width="300" height="320" class="court-bg" />
              <rect x="105" y="0" width="90" height="140" class="court-line" />
              <circle cx="150" cy="140" r="45" class="court-line" />
              <path d="M 105,20 A 20,20 0 0,0 195,20" class="court-line" />
              <path d="M 25,0 L 25,71 A 135,135 0 0,0 275,71 L 275,0" class="court-line" />
              <rect x="135" y="4" width="30" height="2" class="backboard" />
              <circle cx="150" cy="20" r="7.5" class="hoop" />

              @for (d of frame.drawings; track d.id) {
                @if (d.type === 'text') {
                  @if (editingTextId() === d.id) {
                    <foreignObject [attr.x]="d.x1 - 45" [attr.y]="d.y1 - 11" width="90" height="24">
                      <input
                        class="text-edit-input"
                        [ngModel]="d.text"
                        (ngModelChange)="updateTextDrawing(i, d.id, $event)"
                        (blur)="editingTextId.set(null)"
                        (keydown.enter)="editingTextId.set(null)"
                      />
                    </foreignObject>
                  } @else {
                    <text [attr.x]="d.x1" [attr.y]="d.y1" class="play-text" (pointerdown)="onDrawingPointerDown($event, i, d.id)">{{ d.text || '(label)' }}</text>
                  }
                } @else {
                  <path [attr.d]="pathFor(d)" [class]="'drawing drawing-' + d.type" [attr.marker-end]="markerFor(d.type)" (pointerdown)="onDrawingPointerDown($event, i, d.id)" />
                }
              }

              @if (drawState() && drawState()!.frameIndex === i) {
                <line [attr.x1]="drawState()!.x1" [attr.y1]="drawState()!.y1" [attr.x2]="drawState()!.x2" [attr.y2]="drawState()!.y2" class="draw-preview" />
              }

              <circle
                [attr.cx]="frame.ball.x"
                [attr.cy]="frame.ball.y"
                r="5.5"
                class="ball"
                (pointerdown)="onTokenPointerDown($event, i, $any(courtSvg), 'ball')"
              />

              @for (p of frame.players; track p.id) {
                <g (pointerdown)="onTokenPointerDown($event, i, $any(courtSvg), 'player', p.id)" class="player-token">
                  <circle [attr.cx]="p.x" [attr.cy]="p.y" r="12" class="player" />
                  <text [attr.x]="p.x" [attr.y]="p.y" class="player-label">{{ p.id }}</text>
                </g>
              }
            </svg>
          </div>
        }

        <div class="frame-card add-frame-card" (click)="addFrame()">
          <span>+ Add court</span>
        </div>
      </div>

      @if (playbackActive()) {
        <div class="playback-backdrop" (click)="stopPlayback()">
          <div class="playback-panel" (click)="$event.stopPropagation()">
            <div class="playback-header">
              <span>Frame {{ playbackIndex() + 1 }} of {{ frames().length }}</span>
              <button class="btn btn-ghost btn-sm" (click)="stopPlayback()">✕ Close</button>
            </div>
            <svg viewBox="0 0 300 320" class="court playback-court">
              <defs>
                <marker id="pb-arrow-move" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" class="marker-move" /></marker>
                <marker id="pb-arrow-pass" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" class="marker-pass" /></marker>
                <marker id="pb-arrow-dribble" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" class="marker-dribble" /></marker>
                <marker id="pb-screen-tick" markerWidth="8" markerHeight="12" refX="4" refY="6" orient="auto"><line x1="4" y1="0" x2="4" y2="12" class="marker-screen" /></marker>
              </defs>

              <rect x="0" y="0" width="300" height="320" class="court-bg" />
              <rect x="105" y="0" width="90" height="140" class="court-line" />
              <circle cx="150" cy="140" r="45" class="court-line" />
              <path d="M 105,20 A 20,20 0 0,0 195,20" class="court-line" />
              <path d="M 25,0 L 25,71 A 135,135 0 0,0 275,71 L 275,0" class="court-line" />
              <rect x="135" y="4" width="30" height="2" class="backboard" />
              <circle cx="150" cy="20" r="7.5" class="hoop" />

              @if (playbackShowDrawingsFor() !== null) {
                @for (d of frames()[playbackShowDrawingsFor()!].drawings; track d.id) {
                  @if (d.type === 'text') {
                    <text [attr.x]="d.x1" [attr.y]="d.y1" class="play-text">{{ d.text }}</text>
                  } @else {
                    <path [attr.d]="pathFor(d)" [class]="'drawing drawing-' + d.type" [attr.marker-end]="markerForPlayback(d.type)" />
                  }
                }
              }

              <circle [attr.cx]="playbackBall().x" [attr.cy]="playbackBall().y" r="5.5" class="ball ball-animated" />
              @for (p of playbackPlayers(); track p.id) {
                <circle [attr.cx]="p.x" [attr.cy]="p.y" r="12" class="player player-animated" />
                <text [attr.x]="p.x" [attr.y]="p.y" class="player-label playback-label">{{ p.id }}</text>
              }
            </svg>
            <div class="playback-controls">
              <button class="btn btn-ghost btn-sm" (click)="playPlayback()">↻ Replay</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .page {
      padding: var(--space-6);
      max-width: 1100px;
      margin: 0 auto;
    }
    .subtitle {
      color: var(--text-muted);
      margin-top: 0;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      margin-bottom: var(--space-4);
    }
    .toolbar-row {
      display: flex;
      align-items: flex-end;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .toolbar-row + .toolbar-row {
      margin-top: var(--space-3);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .field-label {
      font-size: 0.78rem;
      color: var(--text-muted);
      font-weight: 600;
    }
    .text-input {
      background: var(--surface-hover);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
      min-width: 220px;
    }
    .tool-group {
      display: flex;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .tool-btn {
      background: var(--surface-hover);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
      font-size: 0.82rem;
      cursor: pointer;
    }
    .tool-btn.active {
      background: var(--accent-muted);
      border-color: var(--accent);
      color: var(--accent);
    }
    .playbook-card h4 {
      margin-top: 0;
    }
    .playbook-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .playbook-list li {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      background: var(--surface-hover);
    }
    .play-name {
      font-weight: 600;
      flex: 1;
    }
    .play-updated {
      color: var(--text-faint);
      font-size: 0.78rem;
    }
    .btn.danger {
      color: var(--negative);
    }
    .frames-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(240px, 1fr));
      gap: var(--space-4);
    }
    .frame-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-3);
    }
    .frame-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: var(--space-2);
    }
    .frame-remove {
      background: none;
      border: none;
      color: var(--text-faint);
      cursor: pointer;
      font-size: 0.9rem;
    }
    .frame-remove:hover {
      color: var(--negative);
    }
    .court {
      width: 100%;
      aspect-ratio: 300 / 320;
      background: var(--surface-hover);
      border-radius: var(--radius-sm);
      touch-action: none;
      user-select: none;
    }
    .court.tool-draw {
      cursor: crosshair;
    }
    .court.tool-erase {
      cursor: not-allowed;
    }
    .court-bg {
      fill: transparent;
    }
    .court-line {
      fill: none;
      stroke: var(--border-strong);
      stroke-width: 1.5;
    }
    .backboard {
      fill: var(--text-faint);
    }
    .hoop {
      fill: none;
      stroke: var(--negative);
      stroke-width: 2;
    }
    .player {
      fill: var(--accent);
      stroke: var(--surface);
      stroke-width: 1.5;
      cursor: grab;
    }
    .player-token:active .player {
      cursor: grabbing;
    }
    .player-label {
      fill: var(--accent-text);
      font-size: 10px;
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
    }
    .ball {
      fill: #e8862b;
      stroke: var(--surface);
      stroke-width: 1;
      cursor: grab;
    }
    .drawing {
      fill: none;
      stroke-width: 2;
      cursor: pointer;
    }
    .drawing-move {
      stroke: var(--text);
    }
    .drawing-pass {
      stroke: var(--accent);
      stroke-dasharray: 5, 4;
    }
    .drawing-screen {
      stroke: var(--negative);
      stroke-width: 4;
    }
    .drawing-dribble {
      stroke: var(--positive);
      stroke-dasharray: 2, 3;
    }
    .draw-preview {
      stroke: var(--text-faint);
      stroke-width: 1.5;
      stroke-dasharray: 3, 3;
      pointer-events: none;
    }
    .marker-move {
      fill: var(--text);
    }
    .marker-pass {
      fill: var(--accent);
    }
    .marker-dribble {
      fill: var(--positive);
    }
    .marker-screen {
      stroke: var(--negative);
      stroke-width: 3;
    }
    .play-text {
      font-size: 11px;
      fill: var(--text);
      cursor: text;
    }
    .text-edit-input {
      width: 88px;
      font-size: 11px;
      padding: 1px 3px;
      border: 1px solid var(--accent);
      border-radius: 3px;
    }
    .add-frame-card {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
      border: 2px dashed var(--border-strong);
      color: var(--text-faint);
      cursor: pointer;
      font-weight: 600;
    }
    .add-frame-card:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .hint {
      color: var(--text-muted);
    }
    .playback-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .playback-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      width: min(420px, 90vw);
    }
    .playback-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--space-3);
      font-weight: 600;
      color: var(--text-muted);
      font-size: 0.85rem;
    }
    .playback-court {
      background: var(--surface-hover);
      border-radius: var(--radius-sm);
    }
    .player-animated,
    .ball-animated {
      transition: cx 0.9s ease, cy 0.9s ease;
    }
    .playback-label {
      transition: x 0.9s ease, y 0.9s ease;
    }
    .playback-controls {
      display: flex;
      justify-content: center;
      margin-top: var(--space-3);
    }
  `,
})
export class DrawComponent implements OnInit {
  protected readonly frames = signal<PlayFrame[]>([defaultFrame()]);
  protected readonly tool = signal<Tool>('move');
  protected readonly playName = signal('');
  protected readonly currentPlayId = signal<number | null>(null);
  protected readonly teams = signal<PickerOption[]>([]);
  protected readonly selectedTeamId = signal<number | null>(null);
  protected readonly playbook = signal<PlaybookEntry[]>([]);
  protected readonly showPlaybook = signal(false);
  protected readonly drawState = signal<DrawState | null>(null);
  protected readonly editingTextId = signal<string | null>(null);

  protected readonly playbackActive = signal(false);
  protected readonly playbackIndex = signal(0);
  protected readonly playbackPlayers = signal<{ id: number; x: number; y: number }[]>([]);
  protected readonly playbackBall = signal<{ x: number; y: number }>({ x: 150, y: 250 });
  protected readonly playbackShowDrawingsFor = signal<number | null>(null);
  private playbackToken = 0;

  protected readonly teamOptions = computed<PickerOption[]>(() => this.teams());

  private dragState: DragState | null = null;
  protected undoStack: PlayFrame[][] = [];

  private readonly toast = inject(ToastService);

  async ngOnInit(): Promise<void> {
    const teams = await window.boxscoreApi.listTeams();
    this.teams.set(teams.map((t) => ({ id: t.id, label: t.league_name ? `${t.name} (${t.league_name})` : t.name })));
    await this.refreshPlaybook();
  }

  protected async onTeamChange(teamId: number | null): Promise<void> {
    this.selectedTeamId.set(teamId);
    await this.refreshPlaybook();
  }

  private async refreshPlaybook(): Promise<void> {
    this.playbook.set(await window.boxscoreApi.listPlays(this.selectedTeamId() ?? undefined));
  }

  // --- Undo ---
  private pushUndo(): void {
    this.undoStack.push(structuredClone(this.frames()));
    if (this.undoStack.length > 30) this.undoStack.shift();
  }
  protected undo(): void {
    const prev = this.undoStack.pop();
    if (prev) this.frames.set(prev);
  }

  // --- Frames ---
  protected addFrame(): void {
    this.pushUndo();
    const last = this.frames()[this.frames().length - 1];
    this.frames.update((frames) => [...frames, cloneFrameForContinuation(last)]);
  }
  protected removeFrame(index: number): void {
    this.pushUndo();
    this.frames.update((frames) => frames.filter((_, i) => i !== index));
  }
  protected clearCurrentFrameDrawings(): void {
    this.pushUndo();
    this.frames.update((frames) => frames.map((f) => ({ ...f, drawings: [] })));
  }

  // --- Coordinate conversion ---
  private svgPoint(event: PointerEvent, svg: SVGSVGElement): { x: number; y: number } {
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: Math.max(0, Math.min(300, p.x)), y: Math.max(0, Math.min(320, p.y)) };
  }

  // --- Token dragging (players/ball) ---
  protected onTokenPointerDown(event: PointerEvent, frameIndex: number, svg: SVGSVGElement, kind: 'player' | 'ball', playerId?: number): void {
    if (this.tool() !== 'move') return;
    event.stopPropagation();
    event.preventDefault();
    this.pushUndo();
    this.dragState = { frameIndex, svg, kind, playerId };
  }

  @HostListener('document:pointermove', ['$event'])
  protected onDocPointerMove(event: PointerEvent): void {
    if (this.dragState) {
      const { frameIndex, svg, kind, playerId } = this.dragState;
      const p = this.svgPoint(event, svg);
      this.frames.update((frames) =>
        frames.map((f, i) => {
          if (i !== frameIndex) return f;
          if (kind === 'ball') return { ...f, ball: { x: p.x, y: p.y } };
          return { ...f, players: f.players.map((pl) => (pl.id === playerId ? { ...pl, x: p.x, y: p.y } : pl)) };
        })
      );
      return;
    }
    const ds = this.drawState();
    if (ds) {
      const p = this.svgPoint(event, ds.svg);
      this.drawState.set({ ...ds, x2: p.x, y2: p.y });
    }
  }

  @HostListener('document:pointerup')
  protected onDocPointerUp(): void {
    this.dragState = null;
    const ds = this.drawState();
    if (ds) {
      const dist = Math.hypot(ds.x2 - ds.x1, ds.y2 - ds.y1);
      if (dist > 6) {
        const type = TOOL_TO_DRAWING_TYPE[this.tool()];
        if (type) {
          const drawing: PlayDrawing = { id: uid(), type, x1: ds.x1, y1: ds.y1, x2: ds.x2, y2: ds.y2 };
          this.frames.update((frames) =>
            frames.map((f, i) => (i === ds.frameIndex ? { ...f, drawings: [...f.drawings, drawing] } : f))
          );
        }
      }
      this.drawState.set(null);
    }
  }

  // --- Drawing on the court background ---
  protected onCourtPointerDown(event: PointerEvent, frameIndex: number, svg: SVGSVGElement): void {
    const tool = this.tool();
    if (tool === 'move' || tool === 'erase') return;
    const p = this.svgPoint(event, svg);
    if (tool === 'text') {
      this.pushUndo();
      const drawing: PlayDrawing = { id: uid(), type: 'text', x1: p.x, y1: p.y, x2: p.x, y2: p.y, text: '' };
      this.frames.update((frames) => frames.map((f, i) => (i === frameIndex ? { ...f, drawings: [...f.drawings, drawing] } : f)));
      this.editingTextId.set(drawing.id);
      return;
    }
    this.pushUndo();
    this.drawState.set({ frameIndex, svg, x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  }

  protected onDrawingPointerDown(event: PointerEvent, frameIndex: number, drawingId: string): void {
    event.stopPropagation();
    if (this.tool() === 'erase') {
      this.pushUndo();
      this.frames.update((frames) =>
        frames.map((f, i) => (i === frameIndex ? { ...f, drawings: f.drawings.filter((d) => d.id !== drawingId) } : f))
      );
      return;
    }
    const frame = this.frames()[frameIndex];
    const d = frame.drawings.find((x) => x.id === drawingId);
    if (d && d.type === 'text') this.editingTextId.set(drawingId);
  }

  protected updateTextDrawing(frameIndex: number, drawingId: string, text: string): void {
    this.frames.update((frames) =>
      frames.map((f, i) =>
        i === frameIndex ? { ...f, drawings: f.drawings.map((d) => (d.id === drawingId ? { ...d, text } : d)) } : f
      )
    );
  }

  protected pathFor(d: PlayDrawing): string {
    if (d.type === 'dribble') {
      // A small zigzag between the two endpoints, perpendicular to the line's direction.
      const dx = d.x2 - d.x1;
      const dy = d.y2 - d.y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const segments = Math.max(3, Math.round(len / 12));
      const amp = 4;
      let path = `M ${d.x1},${d.y1}`;
      for (let i = 1; i <= segments; i++) {
        const t = i / segments;
        const bx = d.x1 + dx * t;
        const by = d.y1 + dy * t;
        const side = i % 2 === 0 ? 1 : -1;
        path += ` L ${bx + nx * amp * side},${by + ny * amp * side}`;
      }
      return path;
    }
    return `M ${d.x1},${d.y1} L ${d.x2},${d.y2}`;
  }

  protected markerFor(type: PlayDrawingType): string | null {
    if (type === 'move') return 'url(#arrow-move)';
    if (type === 'pass') return 'url(#arrow-pass)';
    if (type === 'dribble') return 'url(#arrow-dribble)';
    if (type === 'screen') return 'url(#screen-tick)'; // ends in a flat perpendicular tick, not an arrowhead
    return null;
  }
  protected markerForPlayback(type: PlayDrawingType): string | null {
    if (type === 'move') return 'url(#pb-arrow-move)';
    if (type === 'pass') return 'url(#pb-arrow-pass)';
    if (type === 'dribble') return 'url(#pb-arrow-dribble)';
    if (type === 'screen') return 'url(#pb-screen-tick)';
    return null;
  }

  // --- Playback ---
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Steps through every frame: shows its drawn movements for a beat, then animates players/ball smoothly to the next frame's positions. */
  protected async playPlayback(): Promise<void> {
    const frames = this.frames();
    if (frames.length === 0) return;
    const token = ++this.playbackToken;

    this.playbackActive.set(true);
    this.playbackIndex.set(0);
    this.playbackPlayers.set(frames[0].players.map((p) => ({ ...p })));
    this.playbackBall.set({ ...frames[0].ball });
    this.playbackShowDrawingsFor.set(0);

    for (let i = 0; i < frames.length; i++) {
      await this.delay(900);
      if (token !== this.playbackToken) return; // a new playback (or close) started/stopped in the meantime

      if (i < frames.length - 1) {
        this.playbackIndex.set(i + 1);
        this.playbackShowDrawingsFor.set(null); // hide this frame's arrows while the tokens move
        this.playbackPlayers.set(frames[i + 1].players.map((p) => ({ ...p }))); // triggers the CSS position transition
        this.playbackBall.set({ ...frames[i + 1].ball });
        await this.delay(950); // matches the 0.9s transition
        if (token !== this.playbackToken) return;
        this.playbackShowDrawingsFor.set(i + 1);
      }
    }
  }

  protected stopPlayback(): void {
    this.playbackToken++; // cancels any in-flight playPlayback loop
    this.playbackActive.set(false);
  }

  // --- Save / load / delete ---
  protected async savePlay(): Promise<void> {
    const name = this.playName().trim();
    if (!name) return;
    const data: PlayData = { frames: this.frames() };
    try {
      const result = await window.boxscoreApi.savePlay({
        id: this.currentPlayId(),
        teamId: this.selectedTeamId(),
        name,
        data,
      });
      this.currentPlayId.set(result.id);
      await this.refreshPlaybook();
      this.toast.success(`Saved "${name}".`);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to save the play.');
    }
  }

  protected async loadPlay(playId: number): Promise<void> {
    const play = await window.boxscoreApi.getPlay(playId);
    if (!play) return;
    this.undoStack = [];
    this.frames.set(play.data.frames);
    this.playName.set(play.name);
    this.currentPlayId.set(play.id);
    if (play.teamId) this.selectedTeamId.set(play.teamId);
  }

  protected async deletePlay(playId: number): Promise<void> {
    await window.boxscoreApi.deletePlay(playId);
    if (this.currentPlayId() === playId) this.newPlay();
    await this.refreshPlaybook();
  }

  protected newPlay(): void {
    this.undoStack = [];
    this.frames.set([defaultFrame()]);
    this.playName.set('');
    this.currentPlayId.set(null);
  }
}
