const ExcelJS = require('exceljs');
const { BrowserWindow } = require('electron');

/**
 * Builds a workbook from whatever the renderer is currently looking at:
 * either a raw extracted/edited box score (players array) or a stat
 * summary (totals/perGame/advanced) from db:get-*-stats. Detects the
 * shape and writes the appropriate sheet(s).
 */
async function buildWorkbook(payload) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Box Score Analytics';
  workbook.created = new Date();

  if (Array.isArray(payload.players)) {
    addBoxScoreSheet(workbook, payload);
  } else {
    addStatSummarySheet(workbook, payload);
  }

  return workbook;
}

function addBoxScoreSheet(workbook, boxScore) {
  addRosterSheet(workbook, boxScore.team || 'Team', boxScore.players, boxScore.date);
  if (Array.isArray(boxScore.opponentPlayers) && boxScore.opponentPlayers.length > 0) {
    addRosterSheet(workbook, boxScore.opponent || 'Opponent', boxScore.opponentPlayers, boxScore.date);
  }
}

function addRosterSheet(workbook, teamName, players, date) {
  const sheet = workbook.addWorksheet(teamName.slice(0, 31) || 'Box score');
  sheet.addRow([teamName, date]);
  sheet.addRow([]);

  const headers = [
    'Player', 'MIN', 'PTS', 'FGM', 'FGA', '3PM', '3PA', 'FTM', 'FTA',
    'OREB', 'DREB', 'AST', 'STL', 'BLK', 'TOV', 'PF', 'PFD', '+/-', 'SRJ',
  ];
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };

  for (const p of players) {
    sheet.addRow([
      p.name, p.min, p.pts, p.fgm, p.fga, p.tpm, p.tpa, p.ftm, p.fta,
      p.oreb, p.dreb, p.ast, p.stl, p.blk, p.tov, p.pf, p.pfd, p.plus_minus, p.srj,
    ]);
  }

  sheet.columns.forEach((col) => (col.width = 12));
  sheet.getColumn(1).width = 22;
}

function addStatSummarySheet(workbook, summary) {
  const sheet = workbook.addWorksheet('Stat summary');
  sheet.addRow(['Games', summary.games]);
  sheet.addRow([]);

  sheet.addRow(['Totals']).font = { bold: true };
  addKeyValueRows(sheet, summary.totals);
  sheet.addRow([]);

  sheet.addRow(['Per game']).font = { bold: true };
  addKeyValueRows(sheet, summary.perGame);
  sheet.addRow([]);

  sheet.addRow(['Advanced']).font = { bold: true };
  addKeyValueRows(sheet, summary.advanced);

  sheet.columns.forEach((col) => (col.width = 16));
}

function addKeyValueRows(sheet, obj) {
  for (const [key, value] of Object.entries(obj || {})) {
    const numeric = typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
    sheet.addRow([key, numeric]);
  }
}

/** One workbook, one worksheet per metric — each already sorted by computeTeamAdvancedReport. */
function buildAdvancedReportWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Box Score Analytics';
  workbook.created = new Date();

  for (const metric of report.metrics) {
    const sheet = workbook.addWorksheet(sheetNameFor(metric.label));
    sheet.addRow([report.teamName, `${report.leagueName} ${report.seasonYear}`.trim()]);
    sheet.addRow([`Through game #${report.throughGame} of ${report.totalGames} (as of ${report.cutoffDate})`]);
    sheet.addRow([]);
    const headerRow = sheet.addRow(['#', 'Player', metric.label]);
    headerRow.font = { bold: true };
    metric.rows.forEach((r, i) => sheet.addRow([i + 1, r.playerName, r.formatted]));
    sheet.columns.forEach((col) => (col.width = 16));
    sheet.getColumn(2).width = 24;
  }

  return workbook;
}

// Excel worksheet names can't contain \ / * ? : [ ] and are capped at 31 chars.
function sheetNameFor(label) {
  return label.replace(/[\\/*?:[\]]/g, '').slice(0, 31) || 'Metric';
}

/** Renders the same report to a multi-page PDF — one page per metric — via Electron's built-in printToPDF, no external PDF library. */
async function renderReportToPdf(report) {
  const html = buildReportHtml(report);
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    win.destroy();
  }
}

function buildReportHtml(report) {
  const metaLine = `${escapeHtml(report.leagueName)} ${escapeHtml(report.seasonYear)} · Through game #${report.throughGame} of ${report.totalGames} (as of ${escapeHtml(report.cutoffDate)})`;

  const sections = report.metrics
    .map(
      (metric, i) => `
        <section${i > 0 ? ' style="page-break-before: always;"' : ''}>
          <h1>${escapeHtml(report.teamName)}</h1>
          <p class="meta">${metaLine}</p>
          <h2>${escapeHtml(metric.label)}</h2>
          <table>
            <thead><tr><th>#</th><th>Player</th><th>${escapeHtml(metric.label)}</th></tr></thead>
            <tbody>
              ${metric.rows
                .map(
                  (r, idx) =>
                    `<tr><td>${idx + 1}</td><td>${escapeHtml(r.playerName)}</td><td>${escapeHtml(String(r.formatted))}</td></tr>`
                )
                .join('')}
            </tbody>
          </table>
        </section>`
    )
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, Arial, sans-serif; color: #1a1d24; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 16px 0 8px; }
  .meta { font-size: 11px; color: #5b6479; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #dde1e8; padding: 4px 8px; text-align: left; }
  th { background: #f0f1f5; }
  td:first-child, th:first-child { width: 32px; text-align: center; }
</style>
</head>
<body>${sections}</body>
</html>`;
}

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, (c) => map[c]);
}

const GAME_BOX_SCORE_STAT_KEYS = [
  'min', 'pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta',
  'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pfd', 'plus_minus', 'srj',
];
const GAME_BOX_SCORE_HEADERS = [
  'Player', 'MIN', 'PTS', 'FGM', 'FGA', '3PM', '3PA', 'FTM', 'FTA',
  'OREB', 'DREB', 'AST', 'STL', 'BLK', 'TOV', 'PF', 'PFD', '+/-', 'SRJ',
];

/** One workbook, one worksheet per team — same "roster + totals row" template as the app's own box-score entry table. */
function buildGameBoxScoreWorkbook(box) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Box Score Analytics';
  workbook.created = new Date();
  addGameBoxScoreSheet(workbook, box.homeTeamName, box.homeRoster, box.homeTotals, box);
  addGameBoxScoreSheet(workbook, box.awayTeamName, box.awayRoster, box.awayTotals, box);
  return workbook;
}

function addGameBoxScoreSheet(workbook, teamName, roster, totals, box) {
  const sheet = workbook.addWorksheet(sheetNameFor(teamName));
  sheet.addRow([teamName, `${box.leagueName} ${box.seasonYear}`.trim(), box.date]);
  sheet.addRow([]);
  const headerRow = sheet.addRow(GAME_BOX_SCORE_HEADERS);
  headerRow.font = { bold: true };
  for (const p of roster) {
    sheet.addRow([p.name, ...GAME_BOX_SCORE_STAT_KEYS.map((k) => p[k])]);
  }
  const totalsRow = sheet.addRow(['Total', ...GAME_BOX_SCORE_STAT_KEYS.map((k) => totals[k] ?? 0)]);
  totalsRow.font = { bold: true };
  sheet.columns.forEach((col) => (col.width = 10));
  sheet.getColumn(1).width = 22;
}

/** Same hidden-BrowserWindow + printToPDF technique as renderReportToPdf, one page per team. */
async function renderGameBoxScoreToPdf(box) {
  const html = buildGameBoxScoreHtml(box);
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    win.destroy();
  }
}

function buildGameBoxScoreHtml(box) {
  const metaLine = `${escapeHtml(box.leagueName)} ${escapeHtml(box.seasonYear)} · ${escapeHtml(box.date)}`;
  const teamSection = (teamName, roster, totals, isFirst) => `
    <section${isFirst ? '' : ' style="page-break-before: always;"'}>
      <h1>${escapeHtml(box.homeTeamName)} vs ${escapeHtml(box.awayTeamName)}</h1>
      <p class="meta">${metaLine}</p>
      <h2>${escapeHtml(teamName)}</h2>
      <table>
        <thead><tr>${GAME_BOX_SCORE_HEADERS.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>
          ${roster
            .map(
              (p) =>
                `<tr><td>${escapeHtml(p.name)}</td>${GAME_BOX_SCORE_STAT_KEYS.map((k) => `<td>${escapeHtml(String(p[k]))}</td>`).join('')}</tr>`
            )
            .join('')}
          <tr class="totals"><td>Total</td>${GAME_BOX_SCORE_STAT_KEYS.map((k) => `<td>${escapeHtml(String(totals[k] ?? 0))}</td>`).join('')}</tr>
        </tbody>
      </table>
    </section>`;

  const sections =
    teamSection(box.homeTeamName, box.homeRoster, box.homeTotals, true) +
    teamSection(box.awayTeamName, box.awayRoster, box.awayTotals, false);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, Arial, sans-serif; color: #1a1d24; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 16px 0 8px; }
  .meta { font-size: 11px; color: #5b6479; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th, td { border: 1px solid #dde1e8; padding: 3px 6px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th { background: #f0f1f5; }
  tr.totals td { font-weight: bold; border-top: 2px solid #1a1d24; }
</style>
</head>
<body>${sections}</body>
</html>`;
}

function fmtPlayerNameForPdf(raw) {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return raw;
  const toTitle = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return `${toTitle(parts[1])} ${toTitle(parts[0])}`;
}
function pct(v) {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
}
function num(v, decimals = 1) {
  return v === null || v === undefined ? '—' : v.toFixed(decimals);
}
/** Minutes are decimal (23.6167 = 23 min 37 sec) — convert to real base-60 MM.SS, not a raw decimal round. */
function minFmt(v) {
  if (v === null || v === undefined) return '—';
  const total = Math.max(0, v);
  const mins = Math.floor(total);
  let secs = Math.round((total - mins) * 60);
  let m = mins;
  if (secs === 60) {
    secs = 0;
    m += 1;
  }
  return `${m}.${secs.toString().padStart(2, '0')}`;
}

/**
 * Inline half-court + shot dots SVG, matching the app's own shot-chart
 * component (same 0-300x0-320 coordinate space, same court markings) so the
 * PDF looks the same as the on-screen Scouting report. Returns an empty-state
 * message instead of a chart when there's no real shot-location data.
 */
function shotChartSvg(shots, widthPx) {
  if (!shots || shots.length === 0) {
    return '<p class="hint">No shot-location data imported yet.</p>';
  }
  const heightPx = Math.round((widthPx * 320) / 300);
  const dots = shots
    .map((s) =>
      s.made
        ? `<circle cx="${s.x}" cy="${s.y}" r="4" fill="#35d07f" fill-opacity="0.85" />`
        : `<path d="M ${s.x - 4},${s.y - 4} L ${s.x + 4},${s.y + 4} M ${s.x - 4},${s.y + 4} L ${s.x + 4},${s.y - 4}" stroke="#ff5c7a" stroke-width="1.5" stroke-opacity="0.75" />`
    )
    .join('');
  const fgm = shots.filter((s) => s.made).length;
  const fga = shots.length;
  const pctStr = fga === 0 ? '—' : `${((fgm / fga) * 100).toFixed(1)}%`;
  return `
    <svg viewBox="0 0 300 320" width="${widthPx}" height="${heightPx}" style="background:#f6f7fa;border-radius:4px;">
      <rect x="0" y="0" width="300" height="320" fill="transparent" />
      <rect x="105" y="0" width="90" height="140" fill="none" stroke="#8a91a6" stroke-width="1.5" />
      <circle cx="150" cy="140" r="45" fill="none" stroke="#8a91a6" stroke-width="1.5" />
      <path d="M 105,20 A 20,20 0 0,0 195,20" fill="none" stroke="#8a91a6" stroke-width="1.5" />
      <path d="M 25,0 L 25,71 A 135,135 0 0,0 275,71 L 275,0" fill="none" stroke="#8a91a6" stroke-width="1.5" />
      <rect x="135" y="4" width="30" height="2" fill="#8a91a6" />
      <circle cx="150" cy="20" r="7.5" fill="none" stroke="#ff5c7a" stroke-width="2" />
      ${dots}
    </svg>
    <p class="meta">${fgm}-${fga} (${pctStr})</p>`;
}

/** Same hidden-BrowserWindow + printToPDF technique as the other exports in this file. */
async function renderScoutingReportToPdf(report, keysToGame, playerNotes, teamShots, playerShotsByPlayerId) {
  const html = buildScoutingReportHtml(report, keysToGame, playerNotes, teamShots, playerShotsByPlayerId);
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    win.destroy();
  }
}

function buildScoutingReportHtml(report, keysToGame, playerNotes, teamShots, playerShotsByPlayerId) {
  const notesByPlayer = new Map((playerNotes || []).map((n) => [n.playerId, n]));
  const shotsFor = (playerId) => playerShotsByPlayerId?.get?.(playerId) ?? playerShotsByPlayerId?.[playerId] ?? null;
  const title = `${escapeHtml(report.opponentTeamName)} — Scouting Report`;
  const matchup = `${escapeHtml(report.ourTeamName)} vs. ${escapeHtml(report.opponentTeamName)} · ${escapeHtml(report.gameDate)}`;
  const record = `${report.record.wins}-${report.record.losses}`;

  const teamStatsSection = () => {
    const rowsFor = (label, r) =>
      !r
        ? ''
        : `<tr><td>${escapeHtml(label)}</td><td>${num(r.pts)}</td><td>${num(r.fgm)}-${num(r.fga)}</td><td>${pct(r.fgPct)}</td><td>${num(r.tpm)}-${num(r.tpa)}</td><td>${pct(r.tpPct)}</td><td>${num(r.ftm)}-${num(r.fta)}</td><td>${pct(r.ftPct)}</td><td>${num(r.ast)}</td><td>${num(r.reb)}</td><td>${num(r.stl)}</td><td>${num(r.blk)}</td><td>${num(r.tov)}</td><td>${num(r.pace)}</td><td>${num(r.ortg)}</td><td>${num(r.drtg)}</td></tr>`;
    const meetingRows = report.teamStats.meetings
      .map((m) => rowsFor(`${escapeHtml(m.date)} ${escapeHtml(m.site)} ${escapeHtml(m.ourTeamName)}`, m.stats))
      .join('');
    return `
      <h2>Team Stats</h2>
      <table>
        <thead><tr><th>Split</th><th>PTS</th><th>FGM-A</th><th>FG%</th><th>3PM-A</th><th>3P%</th><th>FTM-A</th><th>FT%</th><th>AST</th><th>REB</th><th>STL</th><th>BLK</th><th>TOV</th><th>PACE</th><th>ORTG</th><th>DRTG</th></tr></thead>
        <tbody>
          ${rowsFor('All', report.teamStats.allOff)}
          ${rowsFor('Last 5', report.teamStats.last5)}
          ${meetingRows}
        </tbody>
      </table>`;
  };

  const impactIqSection = () => {
    const rowsFor = (label, side) =>
      `<tr><td>${escapeHtml(label)}</td><td>${pct(side.efgPct)}</td><td>${pct(side.tsPct)}</td><td>${pct(side.tovPct)}</td><td>${pct(side.astPct)}</td><td>${pct(side.trebPct)}</td><td>${pct(side.ftRate)}</td><td>${pct(side.ftPct)}</td></tr>`;
    return `
      <h2>Impact IQ Factors</h2>
      <table>
        <thead><tr><th></th><th>eFG%</th><th>TS%</th><th>TOV%</th><th>AST%</th><th>REB%</th><th>FT-R</th><th>FT%</th></tr></thead>
        <tbody>
          ${rowsFor(`${escapeHtml(report.ourTeamName)} Off`, report.impactIqFactors.us.off)}
          ${rowsFor(`${escapeHtml(report.ourTeamName)} Def`, report.impactIqFactors.us.def)}
          ${rowsFor(`${escapeHtml(report.opponentTeamName)} Off`, report.impactIqFactors.opponent.off)}
          ${rowsFor(`${escapeHtml(report.opponentTeamName)} Def`, report.impactIqFactors.opponent.def)}
        </tbody>
      </table>`;
  };

  const depthChartSection = `
    <h2>Depth Chart</h2>
    <table>
      <thead><tr>${report.depthChart.map((d) => `<th>${escapeHtml(d.position)}</th>`).join('')}</tr></thead>
      <tbody>
        <tr>${report.depthChart
          .map(
            (d) =>
              `<td>${d.players.map((p) => escapeHtml(fmtPlayerNameForPdf(p.name))).join('<br>') || '—'}</td>`
          )
          .join('')}</tr>
      </tbody>
    </table>`;

  const rosterSection = `
    <h2>Cumulative Boxscore</h2>
    <table>
      <thead><tr><th>Player</th><th>GP</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TOV</th></tr></thead>
      <tbody>
        ${report.roster
          .map(
            (p) =>
              `<tr><td>${escapeHtml(fmtPlayerNameForPdf(p.name))}</td><td>${p.games}</td><td>${minFmt(p.perGame.min)}</td><td>${num(p.perGame.pts)}</td><td>${num((p.perGame.oreb ?? 0) + (p.perGame.dreb ?? 0))}</td><td>${num(p.perGame.ast)}</td><td>${num(p.perGame.stl)}</td><td>${num(p.perGame.blk)}</td><td>${num(p.perGame.tov)}</td></tr>`
          )
          .join('')}
      </tbody>
    </table>`;

  const pppSection = report.pointsPerPeriod
    ? `
    <h2>Points Per Period</h2>
    <table>
      <thead><tr><th></th><th>1st</th><th>2nd</th><th>3rd</th><th>4th+OT</th></tr></thead>
      <tbody>
        <tr><td>${escapeHtml(report.opponentTeamName)}</td>${report.pointsPerPeriod.team.map((v) => `<td>${num(v)}</td>`).join('')}</tr>
        <tr><td>Opponents</td>${report.pointsPerPeriod.opponent.map((v) => `<td>${num(v)}</td>`).join('')}</tr>
      </tbody>
    </table>`
    : '';

  const advStatsSection = `
    <h2>Team Advanced Stats</h2>
    <table>
      <thead><tr><th>W-L</th><th>PW%</th><th>ORTG</th><th>DRTG</th><th>NRTG</th><th>PACE</th><th>FT-R</th><th>3P-R</th><th>Poss</th></tr></thead>
      <tbody>
        <tr><td>${record}</td><td>${pct(report.advStatsRow.pythagoreanWinPct)}</td><td>${num(report.advStatsRow.ortg)}</td><td>${num(report.advStatsRow.drtg)}</td><td>${num(report.advStatsRow.netRating)}</td><td>${num(report.advStatsRow.pace)}</td><td>${pct(report.advStatsRow.ftRate)}</td><td>${pct(report.advStatsRow.threePtRate)}</td><td>${num(report.advStatsRow.possessions)}</td></tr>
      </tbody>
    </table>`;

  const leadersRow = (title, rows, valueFn) => `
    <h3>${escapeHtml(title)}</h3>
    <table><tbody>
      ${rows.map((r) => `<tr><td>${escapeHtml(fmtPlayerNameForPdf(r.name))}</td><td>${valueFn(r)}</td></tr>`).join('')}
    </tbody></table>`;

  const leadersSection = `
    <h2>Leaders</h2>
    ${leadersRow('Top Scorers', report.leaders.topScorers, (r) => num(r.value))}
    ${leadersRow('3PT Shooters', report.leaders.threePtShooters, (r) => `${r.tpm}-${r.tpa} (${pct(r.tpPct)})`)}
    ${leadersRow('FT Shooters', report.leaders.ftShooters, (r) => `${r.ftm}-${r.fta} (${pct(r.ftPct)})`)}
    ${leadersRow('Top Rebounders', report.leaders.topRebounders, (r) => `${r.reb} (${r.oreb} OREB)`)}
    ${leadersRow('Ball Control', report.leaders.ballControl, (r) => `${r.ast} AST / ${r.tov} TOV`)}
    ${leadersRow('Defense', report.leaders.defense, (r) => `${num(r.stl)} STL / ${num(r.blk)} BLK`)}`;

  const shootingByZoneSection = `
    <h2>Shooting By Zone — ${escapeHtml(report.opponentTeamName)}</h2>
    ${shotChartSvg(teamShots, 220)}`;

  const playerPagesSection = (report.playerPages.length > 0 ? '<h2>Player Pages</h2>' : '') + report.playerPages
    .map((p, i) => {
      const notes = notesByPlayer.get(p.playerId)?.notes ?? [];
      const meetingRows = p.meetings
        .map(
          (m) =>
            `<tr><td>${escapeHtml(m.date)} ${escapeHtml(m.site)}</td><td>${num(m.perGame.pts)}</td><td>${minFmt(m.perGame.min)}</td><td>${num((m.perGame.oreb ?? 0) + (m.perGame.dreb ?? 0))}</td><td>${num(m.perGame.ast)}</td></tr>`
        )
        .join('');
      const separatorStyle = i > 0 ? 'margin-top: 24px; padding-top: 16px; border-top: 1px solid #dde1e8;' : '';
      return `
        <section style="page-break-inside: avoid; ${separatorStyle}">
          <h1>${escapeHtml(fmtPlayerNameForPdf(p.name))}</h1>
          <p class="meta">${escapeHtml(p.position || '')} ${escapeHtml(p.height || '')}</p>
          <table>
            <thead><tr><th></th><th>PTS</th><th>MIN</th><th>REB</th><th>AST</th></tr></thead>
            <tbody>
              <tr><td>Season</td><td>${num(p.perGame.pts)}</td><td>${minFmt(p.perGame.min)}</td><td>${num((p.perGame.oreb ?? 0) + (p.perGame.dreb ?? 0))}</td><td>${num(p.perGame.ast)}</td></tr>
              ${meetingRows}
            </tbody>
          </table>
          <h3>Shooting</h3>
          ${shotChartSvg(shotsFor(p.playerId), 180)}
          ${notes.length > 0 ? `<h3>Notes</h3><ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
        </section>`;
    })
    .join('');

  const keysSection =
    keysToGame && keysToGame.length > 0
      ? `<h2>Keys to the Game</h2><ul>${keysToGame.map((k) => `<li>${escapeHtml(k)}</li>`).join('')}</ul>`
      : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; color: #1a1d24; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 20px 0 8px; }
  h3 { font-size: 12px; margin: 12px 0 4px; }
  .meta { font-size: 11px; color: #5b6479; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 8px; }
  th, td { border: 1px solid #dde1e8; padding: 3px 6px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th { background: #f0f1f5; }
  ul { font-size: 11px; padding-left: 18px; }
</style>
</head>
<body>
  <h1>${escapeHtml(report.opponentTeamName)}</h1>
  <p class="meta">${matchup} · Record ${record}</p>
  ${keysSection}
  ${rosterSection}
  ${depthChartSection}
  ${impactIqSection()}
  ${teamStatsSection()}
  ${pppSection}
  ${advStatsSection}
  ${shootingByZoneSection}
  ${leadersSection}
  ${playerPagesSection}
</body>
</html>`;
}

module.exports = {
  buildWorkbook,
  buildAdvancedReportWorkbook,
  renderReportToPdf,
  buildGameBoxScoreWorkbook,
  renderGameBoxScoreToPdf,
  renderScoutingReportToPdf,
};
