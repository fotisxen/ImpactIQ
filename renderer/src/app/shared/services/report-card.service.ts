import { Injectable, inject } from '@angular/core';
import { GameBoxScore, StatSummary } from '../../core/models/box-score.model';
import { ToastService } from './toast.service';

/** Fixed dark/orange brand palette for the exported card — deliberately not
 *  theme-dependent, so a card looks the same (and on-brand) wherever it's
 *  shared, regardless of the viewer's or exporter's light/dark setting. */
const BG_TOP = '#171c27';
const BG_BOTTOM = '#0b0e14';
const SURFACE = 'rgba(255, 255, 255, 0.04)';
const BORDER = 'rgba(255, 255, 255, 0.08)';
const TEXT = '#e9edf5';
const TEXT_MUTED = '#8b94a8';
const ACCENT = '#ff7a29';

const FONT = '"Segoe UI", Roboto, Arial, sans-serif';

export interface PlayerOrTeamCardData {
  subjectName: string;
  subtitle: string;
  summary: StatSummary;
}

@Injectable({ providedIn: 'root' })
export class ReportCardService {
  private readonly toast = inject(ToastService);

  async exportPlayerOrTeamCard(data: PlayerOrTeamCardData, suggestedName: string): Promise<void> {
    const base64 = this.renderPlayerOrTeamCard(data);
    await this.save(base64, suggestedName);
  }

  async exportGameCard(box: GameBoxScore, suggestedName: string): Promise<void> {
    const base64 = this.renderGameCard(box);
    await this.save(base64, suggestedName);
  }

  private async save(base64Png: string, suggestedName: string): Promise<void> {
    const result = await window.boxscoreApi.exportImage(base64Png, suggestedName);
    if (result.saved) this.toast.success(`Saved to ${result.filePath}`);
  }

  private renderPlayerOrTeamCard(data: PlayerOrTeamCardData): string {
    const W = 1080;
    const H = 1350;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    this.paintBackground(ctx, W, H);
    this.paintHeader(ctx, W);

    const { summary, subjectName, subtitle } = data;

    ctx.fillStyle = TEXT;
    ctx.font = `800 64px ${FONT}`;
    ctx.textAlign = 'left';
    this.wrapText(ctx, subjectName, 64, 230, W - 128, 70);

    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(subtitle, 64, 290);

    // Headline row: GP / PER / Impact / PIE
    const headline: [string, string][] = [
      ['GP', `${summary.games}`],
      ['PER', summary.per !== null ? summary.per.toFixed(1) : '—'],
      ['IMPACT', summary.impact !== null ? summary.impact.toFixed(1) : '—'],
      ['PIE%', summary.pie !== null ? `${(summary.pie * 100).toFixed(1)}%` : '—'],
    ];
    this.paintStatRow(ctx, headline, 64, 350, W - 128, 160, true);

    // Per-game basics
    ctx.fillStyle = TEXT;
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText('PER GAME', 64, 590);

    const pg = summary.perGame;
    const basics: [string, string][] = [
      ['PTS', pg['pts']?.toFixed(1) ?? '0.0'],
      ['REB', ((pg['oreb'] ?? 0) + (pg['dreb'] ?? 0)).toFixed(1)],
      ['AST', pg['ast']?.toFixed(1) ?? '0.0'],
      ['STL', pg['stl']?.toFixed(1) ?? '0.0'],
      ['BLK', pg['blk']?.toFixed(1) ?? '0.0'],
      ['TOV', pg['tov']?.toFixed(1) ?? '0.0'],
    ];
    this.paintStatRow(ctx, basics, 64, 620, W - 128, 150, false);

    // Shooting splits
    ctx.fillStyle = TEXT;
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText('SHOOTING', 64, 830);

    const adv = summary.advanced;
    const shooting: [string, string][] = [
      ['FG%', this.pct(adv.fg_pct)],
      ['3P%', this.pct(adv.tp_pct)],
      ['FT%', this.pct(adv.ft_pct)],
      ['TS%', this.pct(adv.ts_pct)],
      ['eFG%', this.pct(adv.efg_pct)],
    ];
    this.paintStatRow(ctx, shooting, 64, 860, W - 128, 150, false);

    // DOE (Dean Oliver's Four Factors)
    ctx.fillStyle = TEXT;
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText("DEAN OLIVER'S FOUR FACTORS", 64, 1070);

    const doe: [string, string][] = [
      ['eFG%', this.pct(adv.efg_pct)],
      ['TOV%', this.pct(adv.tov_pct)],
      ['ORB%', this.pct(adv.oreb_pct)],
      ['FTHr', this.pct(adv.ft_rate)],
    ];
    this.paintStatRow(ctx, doe, 64, 1100, W - 128, 150, false);

    this.paintFooter(ctx, W, H);

    return this.toBase64(canvas);
  }

  private renderGameCard(box: GameBoxScore): string {
    const W = 1200;
    const H = 900;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    this.paintBackground(ctx, W, H);
    this.paintHeader(ctx, W);

    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `500 26px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${box.leagueName} · ${box.seasonYear} · ${box.date}`, W / 2, 230);

    const homePts = box.homeTotals['pts'] ?? 0;
    const awayPts = box.awayTotals['pts'] ?? 0;

    ctx.font = `800 54px ${FONT}`;
    ctx.fillStyle = homePts >= awayPts ? ACCENT : TEXT;
    this.wrapTextCentered(ctx, box.homeTeamName, W * 0.27, 320, 380);
    ctx.fillStyle = homePts < awayPts ? ACCENT : TEXT;
    this.wrapTextCentered(ctx, box.awayTeamName, W * 0.73, 320, 380);

    ctx.font = `900 90px ${FONT}`;
    ctx.fillStyle = homePts >= awayPts ? ACCENT : TEXT;
    ctx.fillText(`${homePts}`, W * 0.27, 420);
    ctx.fillStyle = homePts < awayPts ? ACCENT : TEXT;
    ctx.fillText(`${awayPts}`, W * 0.73, 420);

    ctx.font = `700 32px ${FONT}`;
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText('–', W / 2, 415);

    // Team totals comparison
    const rows: [string, keyof typeof box.homeTotals][] = [
      ['REB', 'oreb'],
      ['AST', 'ast'],
      ['STL', 'stl'],
      ['BLK', 'blk'],
      ['TOV', 'tov'],
    ];
    let y = 500;
    ctx.textAlign = 'center';
    for (const [label, key] of rows) {
      const homeVal = key === 'oreb' ? (box.homeTotals['oreb'] ?? 0) + (box.homeTotals['dreb'] ?? 0) : (box.homeTotals[key] ?? 0);
      const awayVal = key === 'oreb' ? (box.awayTotals['oreb'] ?? 0) + (box.awayTotals['dreb'] ?? 0) : (box.awayTotals[key] ?? 0);

      ctx.font = `700 34px ${FONT}`;
      ctx.fillStyle = TEXT;
      ctx.fillText(`${homeVal}`, W * 0.3, y);
      ctx.fillText(`${awayVal}`, W * 0.7, y);

      ctx.font = `600 22px ${FONT}`;
      ctx.fillStyle = TEXT_MUTED;
      ctx.fillText(label, W / 2, y - 5);

      y += 65;
    }

    // Top performer per team
    const homeTop = [...box.homeRoster].sort((a, b) => b.pts - a.pts)[0];
    const awayTop = [...box.awayRoster].sort((a, b) => b.pts - a.pts)[0];
    ctx.font = `600 24px ${FONT}`;
    ctx.fillStyle = ACCENT;
    if (homeTop) ctx.fillText(`Top scorer: ${homeTop.name} — ${homeTop.pts} PTS`, W * 0.3, 830);
    if (awayTop) ctx.fillText(`Top scorer: ${awayTop.name} — ${awayTop.pts} PTS`, W * 0.7, 830);

    this.paintFooter(ctx, W, H);

    return this.toBase64(canvas);
  }

  private paintBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, BG_TOP);
    gradient.addColorStop(1, BG_BOTTOM);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = ACCENT;
    ctx.globalAlpha = 0.08;
    ctx.beginPath();
    ctx.arc(w - 100, 100, 260, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private paintHeader(ctx: CanvasRenderingContext2D, w: number): void {
    ctx.fillStyle = ACCENT;
    ctx.font = `800 26px ${FONT}`;
    ctx.textAlign = w > 1150 ? 'center' : 'left';
    ctx.fillText('BOX SCORE ANALYTICS', ctx.textAlign === 'center' ? w / 2 : 64, ctx.textAlign === 'center' ? 90 : 100);
    ctx.textAlign = 'left';
  }

  private paintFooter(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(64, h - 70);
    ctx.lineTo(w - 64, h - 70);
    ctx.stroke();

    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `500 20px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('Generated with Box Score Analytics — AI-powered basketball data', 64, h - 35);
  }

  /** Draws a row of equal-width stat tiles, each with a big value and a small label underneath. */
  private paintStatRow(
    ctx: CanvasRenderingContext2D,
    stats: [string, string][],
    x: number,
    y: number,
    width: number,
    height: number,
    accent: boolean
  ): void {
    const gap = 20;
    const tileWidth = (width - gap * (stats.length - 1)) / stats.length;

    stats.forEach(([label, value], i) => {
      const tx = x + i * (tileWidth + gap);
      ctx.fillStyle = SURFACE;
      this.roundRect(ctx, tx, y, tileWidth, height, 16);
      ctx.fill();
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = 1;
      this.roundRect(ctx, tx, y, tileWidth, height, 16);
      ctx.stroke();

      ctx.fillStyle = accent ? ACCENT : TEXT;
      ctx.font = `800 ${accent ? 46 : 38}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(value, tx + tileWidth / 2, y + height / 2 + (accent ? 8 : 4));

      ctx.fillStyle = TEXT_MUTED;
      ctx.font = `600 18px ${FONT}`;
      ctx.fillText(label, tx + tileWidth / 2, y + height - 18);
      ctx.textAlign = 'left';
    });
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number): void {
    const words = text.split(' ');
    let line = '';
    let curY = y;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, curY);
        line = word;
        curY += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, curY);
  }

  private wrapTextCentered(ctx: CanvasRenderingContext2D, text: string, centerX: number, y: number, maxWidth: number): void {
    const prevAlign = ctx.textAlign;
    ctx.textAlign = 'center';
    if (ctx.measureText(text).width <= maxWidth) {
      ctx.fillText(text, centerX, y);
    } else {
      // Shrink font until it fits on one line, rather than wrapping — keeps the score-card layout stable.
      let size = 54;
      const family = ctx.font.split('px ')[1] ?? FONT;
      while (size > 24) {
        ctx.font = `800 ${size}px ${family}`;
        if (ctx.measureText(text).width <= maxWidth) break;
        size -= 4;
      }
      ctx.fillText(text, centerX, y);
    }
    ctx.textAlign = prevAlign;
  }

  private pct(n: number | undefined | null): string {
    return `${((n ?? 0) * 100).toFixed(1)}%`;
  }

  private toBase64(canvas: HTMLCanvasElement): string {
    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.split(',')[1];
  }
}
