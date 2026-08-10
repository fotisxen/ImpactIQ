import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="home-page">
      <section class="hero">
        <span class="eyebrow">Box Score Analytics</span>
        <h1>Turn a photo of a box score into full basketball analytics.</h1>
        <p class="lede">
          Snap a picture, and let AI read the stats for you — or type them in by hand. Either way, you
          get advanced stats, PER, PIE, league comparisons, and trend charts in seconds.
        </p>
        <div class="hero-actions">
          <a routerLink="/upload" class="btn btn-primary">Upload a photo</a>
          <a routerLink="/manual-entry" class="btn btn-secondary">Enter stats manually</a>
        </div>
      </section>

      <section class="steps">
        <div class="step-card">
          <span class="step-number">1</span>
          <h3>Capture the box score</h3>
          <p>Upload a photo or screenshot of a game's box score — or skip the photo and type the stats in yourself.</p>
        </div>
        <div class="step-card">
          <span class="step-number">2</span>
          <h3>AI reads it for you</h3>
          <p>Claude extracts both rosters' full stat lines automatically, so you just review and correct rather than retype everything.</p>
        </div>
        <div class="step-card">
          <span class="step-number">3</span>
          <h3>Pick the league &amp; teams</h3>
          <p>Match the game to a league, season, and both teams — new leagues and teams can be created on the fly.</p>
        </div>
        <div class="step-card">
          <span class="step-number">4</span>
          <h3>See the analytics</h3>
          <p>Basic stats, four categories of advanced metrics, PER, PIE, and league-average comparisons — for any player or team, across every competition they play in.</p>
        </div>
      </section>

      <section class="highlights">
        <div class="highlight-card">
          <span class="badge badge-accent">Advanced stats</span>
          <p>Scoring, shooting, rebounding, and ball-handling efficiency — split into individual and team versions.</p>
        </div>
        <div class="highlight-card">
          <span class="badge badge-positive">League context</span>
          <p>Every number is measured against real league averages, not in isolation.</p>
        </div>
        <div class="highlight-card">
          <span class="badge" style="background: var(--accent-2-muted); color: var(--accent-2); border-color: transparent;">Multi-competition</span>
          <p>A player or team's stats roll up across every league and cup they play in — combined and per-competition.</p>
        </div>
      </section>
    </div>
  `,
  styles: `
    .home-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-7);
      padding: var(--space-7) var(--space-6);
      max-width: 1100px;
    }

    .hero {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      max-width: 640px;
    }
    .eyebrow {
      color: var(--accent);
      font-weight: 700;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .hero h1 {
      font-size: 2.1rem;
      line-height: 1.15;
      font-weight: 800;
      background: linear-gradient(135deg, var(--text) 40%, var(--accent) 120%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .lede {
      color: var(--text-muted);
      font-size: 1rem;
      line-height: 1.6;
    }
    .hero-actions {
      display: flex;
      gap: var(--space-3);
      margin-top: var(--space-2);
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: var(--space-4);
    }
    .step-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      position: relative;
      overflow: hidden;
    }
    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      border-radius: var(--radius-md);
      background: var(--accent-muted);
      color: var(--accent);
      font-weight: 800;
      font-size: 0.95rem;
    }
    .step-card h3 {
      font-size: 1rem;
      margin-top: var(--space-1);
    }
    .step-card p {
      color: var(--text-muted);
      font-size: 0.85rem;
      line-height: 1.5;
    }

    .highlights {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: var(--space-4);
    }
    .highlight-card {
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .highlight-card p {
      color: var(--text-muted);
      font-size: 0.85rem;
      line-height: 1.5;
    }
  `,
})
export class HomeComponent {}
