const ExcelJS = require('exceljs');

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
    'OREB', 'DREB', 'AST', 'STL', 'BLK', 'TOV', 'PF', 'PFD', '+/-',
  ];
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };

  for (const p of players) {
    sheet.addRow([
      p.name, p.min, p.pts, p.fgm, p.fga, p.tpm, p.tpa, p.ftm, p.fta,
      p.oreb, p.dreb, p.ast, p.stl, p.blk, p.tov, p.pf, p.pfd, p.plus_minus,
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

module.exports = { buildWorkbook };
