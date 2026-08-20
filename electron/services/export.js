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

module.exports = { buildWorkbook, buildAdvancedReportWorkbook, renderReportToPdf };
