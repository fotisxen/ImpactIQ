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
        <h1>Deep, reliable basketball data — to evaluate every player and team with confidence.</h1>
        <p class="lede">
          Basic stats, five categories of advanced metrics, PER, PIE, and real league-average comparisons —
          the kind of data you need to actually judge a player's or team's performance, not just glance at
          a scoreline.
        </p>
        <p class="lede ai-lede">
          <span class="badge badge-accent">AI-powered</span>
          Getting there is effortless: upload a photo of the box score and Claude AI reads and structures
          every stat line for you automatically — or type them in by hand if you'd rather.
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
          <p>Claude AI extracts both rosters' full stat lines automatically, so you just review and correct rather than retype everything.</p>
        </div>
        <div class="step-card">
          <span class="step-number">3</span>
          <h3>Pick the league &amp; teams</h3>
          <p>Match the game to a league, season, and both teams — new leagues and teams can be created on the fly.</p>
        </div>
        <div class="step-card">
          <span class="step-number">4</span>
          <h3>Get data you can actually evaluate with</h3>
          <p>Basic stats, five categories of advanced metrics, PER, PIE, and league-average comparisons — for any player or team, across every competition they play in.</p>
        </div>
      </section>

      <section class="highlights">
        <div class="highlight-card">
          <span class="badge badge-accent">Trustworthy data</span>
          <p>Scoring, shooting, rebounding, ball-handling, and Dean Oliver's Four Factors — individual and team versions, measured against real league averages, not in isolation.</p>
        </div>
        <div class="highlight-card">
          <span class="badge badge-positive">AI-powered extraction</span>
          <p>Claude AI reads a photographed box score for you — accurate stat extraction without the manual data entry.</p>
        </div>
        <div class="highlight-card">
          <span class="badge" style="background: var(--accent-2-muted); color: var(--accent-2); border-color: transparent;">Multi-competition</span>
          <p>A player or team's stats roll up across every league and cup they play in — combined and per-competition.</p>
        </div>
      </section>

      <section class="features">
        <h2>Everywhere your data goes to work</h2>
        <div class="feature-grid">
          <a routerLink="/dashboard" class="feature-card">
            <h3>Dashboard</h3>
            <p>Player, Team, and League views with headline metrics, trend charts, season-scoped stats, standings, and a league-wide player leaderboard.</p>
          </a>
          <a routerLink="/four-factors" class="feature-card">
            <h3>Four Factors</h3>
            <p>Dean Oliver's framework broken into Primary, Context, and Strategic metrics — real numbers where the data supports them, an honest N/A everywhere else.</p>
          </a>
          <a routerLink="/game-insights" class="feature-card">
            <h3>Game Insights</h3>
            <p>Automatic per-player and per-team highlights — what stood out above or below their usual level, computed locally with no extra cost.</p>
          </a>
          <a routerLink="/import-pbp" class="feature-card">
            <h3>Import play-by-play</h3>
            <p>Bring in a full play-by-play file for a game to unlock lineup combinations, real Net Rating, assisted FG%, and other possession-level metrics.</p>
          </a>
          <a routerLink="/compare" class="feature-card">
            <h3>Compare</h3>
            <p>Two players or two teams side by side — pick each side's league, season, and subject independently and see who comes out ahead on every stat.</p>
          </a>
          <div class="feature-card static">
            <h3>Export to Excel &amp; PDF</h3>
            <p>Per-team advanced-metrics reports and individual box scores, ranked and formatted, ready to hand off or archive.</p>
          </div>
          <div class="feature-card static">
            <h3>Dark &amp; light theme</h3>
            <p>Switch themes any time from the sidebar — your choice is remembered.</p>
          </div>
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
    .ai-lede {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
      font-size: 0.92rem;
    }
    .ai-lede .badge {
      flex-shrink: 0;
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

    .features {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .features h2 {
      font-size: 1.2rem;
    }
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: var(--space-4);
    }
    .feature-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      text-decoration: none;
      color: inherit;
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    a.feature-card:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .feature-card.static {
      cursor: default;
    }
    .feature-card h3 {
      font-size: 0.95rem;
    }
    .feature-card p {
      color: var(--text-muted);
      font-size: 0.85rem;
      line-height: 1.5;
      margin: 0;
    }
  `,
})
export class HomeComponent {}
