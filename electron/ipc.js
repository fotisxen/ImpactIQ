const { ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const { extractBoxScore } = require('./services/ocr');
const {
  sumRows,
  perGame,
  advancedStatLine,
  per: computePER,
  impactScore,
  reboundingStatLine,
  ballHandlingStatLine,
  pie: computePIE,
} = require('./services/statsEngine');
const { signup, login, logout } = require('./services/auth');
const {
  listOrganizations,
  createOrganization,
  listMyInvites,
  listSentInvites,
  createInvite,
  acceptInvite,
  declineInvite,
  revokeInvite,
} = require('./services/organizations');
const {
  getBaseSubscription,
  cancelBaseSubscription,
  getUploadStatus,
  cancelUploadSubscription,
  listUploadPlans,
  assertUploadQuotaAvailable,
  recordPhotoUpload,
  getProfile,
  updateProfile,
  changePassword,
  createCheckoutSession,
  createPortalSession,
} = require('./services/subscriptions');
const { buildWorkbook } = require('./services/export');

function registerIpcHandlers(db, mainWindow) {
  ipcMain.handle('ocr:extract-box-score', async (_event, base64Image, mediaType) => {
    await assertUploadQuotaAvailable();
    const result = await extractBoxScore(base64Image, mediaType);
    await recordPhotoUpload();
    return result;
  });

  ipcMain.handle('auth:signup', (_event, { email, password, profile }) => signup(email, password, profile));
  ipcMain.handle('auth:login', (_event, { email, password }) => login(email, password));
  ipcMain.handle('auth:logout', () => logout());
  ipcMain.handle('auth:list-organizations', () => listOrganizations());

  ipcMain.handle('team:create-organization', (_event, name) => createOrganization(name));
  ipcMain.handle('team:list-my-invites', () => listMyInvites());
  ipcMain.handle('team:list-sent-invites', () => listSentInvites());
  ipcMain.handle('team:create-invite', (_event, email) => createInvite(email));
  ipcMain.handle('team:accept-invite', (_event, inviteId) => acceptInvite(inviteId));
  ipcMain.handle('team:decline-invite', (_event, inviteId) => declineInvite(inviteId));
  ipcMain.handle('team:revoke-invite', (_event, inviteId) => revokeInvite(inviteId));

  ipcMain.handle('account:get-profile', () => getProfile());
  ipcMain.handle('account:update-profile', (_event, profile) => updateProfile(profile));
  ipcMain.handle('account:change-password', (_event, newPassword) => changePassword(newPassword));

  ipcMain.handle('subscription:get-base', () => getBaseSubscription());
  ipcMain.handle('subscription:cancel-base', () => cancelBaseSubscription());
  ipcMain.handle('subscription:get-upload-status', () => getUploadStatus());
  ipcMain.handle('subscription:cancel-upload', () => cancelUploadSubscription());

  ipcMain.handle('subscription:checkout', async (_event, params) => {
    const url = await createCheckoutSession(params);
    await shell.openExternal(url);
  });
  ipcMain.handle('subscription:open-portal', async () => {
    const url = await createPortalSession();
    await shell.openExternal(url);
  });
  ipcMain.handle('subscription:list-upload-plans', () => listUploadPlans());

  ipcMain.handle('export:excel', async (_event, { payload, suggestedName }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export to Excel',
      defaultPath: suggestedName || 'box-score-export.xlsx',
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { saved: false };

    const workbook = await buildWorkbook(payload);
    const buffer = await workbook.xlsx.writeBuffer();
    await fs.writeFile(filePath, buffer);
    return { saved: true, filePath };
  });

  ipcMain.handle('db:save-game', (_event, game) => {
    const saveTx = db.transaction((g) => {
      const teamId = upsertTeam(db, g.team, g.leagueId);
      const oppId = upsertTeam(db, g.opponent, g.leagueId);

      const gameId = db
        .prepare(
          `INSERT INTO games (season_id, date, home_team_id, away_team_id, source)
           VALUES (@seasonId, @date, @homeTeamId, @awayTeamId, 'photo')`
        )
        .run({ seasonId: g.seasonId, date: g.date, homeTeamId: teamId, awayTeamId: oppId }).lastInsertRowid;

      insertRoster(db, gameId, teamId, g.players || []);
      insertRoster(db, gameId, oppId, g.opponentPlayers || []);
      return gameId;
    });

    return saveTx(game);
  });

  ipcMain.handle('db:get-player-stats', (_event, playerId) => {
    const rows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(playerId);
    const player = db.prepare(`SELECT team_id FROM players WHERE id = ?`).get(playerId);
    const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(player.team_id);

    const teamAgg = teamAggregate(db, player.team_id);
    const oppAgg = opponentAggregate(db, player.team_id);
    const leagueAgg = leagueAggregate(db, team.league_id);
    return buildStatSummary({ rows, games: rows.length, isTeam: false, teamAgg, oppAgg, leagueAgg });
  });

  ipcMain.handle('db:get-team-stats', (_event, teamId) => {
    const teamAgg = teamAggregate(db, teamId);
    const oppAgg = opponentAggregate(db, teamId);
    const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(teamId);
    const leagueAgg = leagueAggregate(db, team.league_id);
    return buildStatSummary({ rows: teamAgg.rows, games: teamAgg.games, isTeam: true, teamAgg, oppAgg, leagueAgg });
  });

  ipcMain.handle('db:get-league-averages', (_event, leagueId, seasonId) => {
    const rows = leagueSeasonRows(db, leagueId, seasonId);
    const games = new Set(rows.map((r) => r.game_id)).size;
    const teamGames = new Set(rows.map((r) => `${r.game_id}:${r.team_id}`)).size;
    const agg = { rows, totals: sumRows(rows), games, teamGames };
    // No single "opponent" for a whole league — self-referential, same as
    // teamAgg/leagueAgg, and mathematically sound (see PER's own self-check).
    return buildStatSummary({
      rows,
      games,
      isTeam: true,
      teamAgg: agg,
      oppAgg: agg,
      leagueAgg: agg,
      perGameDivisor: teamGames, // the /2 fix: a game's totals are 2 teams' worth, not 1
    });
  });

  ipcMain.handle('db:get-team-all-competitions', (_event, teamId) => {
    const team = db.prepare(`SELECT name FROM teams WHERE id = ?`).get(teamId);
    if (!team) return null;

    const siblings = db
      .prepare(
        `SELECT t.id, t.league_id, l.name AS league_name
         FROM teams t JOIN leagues l ON l.id = t.league_id
         WHERE t.name = ?`
      )
      .all(team.name)
      .map((s) => ({ ...s, agg: teamAggregate(db, s.id), oppAgg: opponentAggregate(db, s.id) }));

    const perLeague = siblings.map((s) => ({
      leagueId: s.league_id,
      leagueName: s.league_name,
      ...buildStatSummary({
        rows: s.agg.rows,
        games: s.agg.games,
        isTeam: true,
        teamAgg: s.agg,
        oppAgg: s.oppAgg,
        leagueAgg: leagueAggregate(db, s.league_id),
      }),
    }));

    const allRows = siblings.flatMap((s) => s.agg.rows);
    const combined = buildCombinedSummary(allRows, new Set(allRows.map((r) => r.game_id)).size);

    return { combined, perLeague };
  });

  ipcMain.handle('db:get-player-all-competitions', (_event, playerId) => {
    const player = db
      .prepare(
        `SELECT p.name AS player_name, t.name AS team_name
         FROM players p JOIN teams t ON t.id = p.team_id
         WHERE p.id = ?`
      )
      .get(playerId);
    if (!player) return null;

    const siblings = db
      .prepare(
        `SELECT p.id, t.id AS team_id, t.league_id, l.name AS league_name
         FROM players p
         JOIN teams t ON t.id = p.team_id
         JOIN leagues l ON l.id = t.league_id
         WHERE p.name = ? AND t.name = ?`
      )
      .all(player.player_name, player.team_name)
      .map((s) => {
        const rows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(s.id);
        return { ...s, rows, games: rows.length };
      });

    const perLeague = siblings.map((s) => ({
      leagueId: s.league_id,
      leagueName: s.league_name,
      ...buildStatSummary({
        rows: s.rows,
        games: s.games,
        isTeam: false,
        teamAgg: teamAggregate(db, s.team_id),
        oppAgg: opponentAggregate(db, s.team_id),
        leagueAgg: leagueAggregate(db, s.league_id),
      }),
    }));

    const allRows = siblings.flatMap((s) => s.rows);
    const combined = buildCombinedSummary(allRows, allRows.length);

    return { combined, perLeague };
  });

  ipcMain.handle('db:get-league-team-rankings', (_event, leagueId, seasonId) => {
    const rows = leagueSeasonRows(db, leagueId, seasonId);

    const byTeam = new Map();
    for (const row of rows) {
      if (!byTeam.has(row.team_id)) {
        byTeam.set(row.team_id, { teamName: row.team_name, rows: [], gameIds: new Set() });
      }
      const entry = byTeam.get(row.team_id);
      entry.rows.push(row);
      entry.gameIds.add(row.game_id);
    }

    const leagueAgg = leagueAggregate(db, leagueId);

    return [...byTeam.entries()].map(([teamId, entry]) => {
      const teamAgg = { rows: entry.rows, totals: sumRows(entry.rows), games: entry.gameIds.size };
      const oppAgg = opponentAggregate(db, teamId);
      return {
        teamId,
        teamName: entry.teamName,
        ...buildStatSummary({
          rows: entry.rows,
          games: entry.gameIds.size,
          isTeam: true,
          teamAgg,
          oppAgg,
          leagueAgg,
        }),
      };
    });
  });

  ipcMain.handle('db:list-teams', () => db.prepare(`SELECT * FROM teams ORDER BY name`).all());

  ipcMain.handle('db:list-players', (_event, teamId) =>
    db.prepare(`SELECT * FROM players WHERE team_id = ? ORDER BY name`).all(teamId)
  );

  ipcMain.handle('db:list-leagues', () => db.prepare(`SELECT * FROM leagues ORDER BY name`).all());

  ipcMain.handle('db:create-league', (_event, { name, country, tier }) => {
    const existing = db.prepare(`SELECT id FROM leagues WHERE name = ?`).get(name);
    if (existing) return existing.id;
    return db
      .prepare(`INSERT INTO leagues (name, country, tier, source) VALUES (?, ?, ?, 'manual')`)
      .run(name, country || null, tier || null).lastInsertRowid;
  });

  ipcMain.handle('db:list-seasons', (_event, leagueId) =>
    db.prepare(`SELECT * FROM seasons WHERE league_id = ? ORDER BY year DESC`).all(leagueId)
  );

  ipcMain.handle('db:create-season', (_event, { leagueId, year }) => {
    const existing = db
      .prepare(`SELECT id FROM seasons WHERE league_id = ? AND year = ?`)
      .get(leagueId, year);
    if (existing) return existing.id;
    return db
      .prepare(`INSERT INTO seasons (league_id, year) VALUES (?, ?)`)
      .run(leagueId, year).lastInsertRowid;
  });

  ipcMain.handle('db:create-team', (_event, { leagueId, name, isMyTeam }) => {
    const existing = db.prepare(`SELECT id FROM teams WHERE name = ? AND league_id = ?`).get(name, leagueId);
    if (existing) {
      if (isMyTeam) db.prepare(`UPDATE teams SET is_my_team = 1 WHERE id = ?`).run(existing.id);
      return existing.id;
    }
    return db
      .prepare(`INSERT INTO teams (league_id, name, is_my_team) VALUES (?, ?, ?)`)
      .run(leagueId, name, isMyTeam ? 1 : 0).lastInsertRowid;
  });

  ipcMain.handle('db:get-player-game-log', (_event, playerId) =>
    db
      .prepare(
        `SELECT bs.*, g.date AS date,
                CASE WHEN g.home_team_id = p.team_id THEN away.name ELSE home.name END AS opponent
         FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         JOIN games g ON g.id = bs.game_id
         JOIN teams home ON home.id = g.home_team_id
         JOIN teams away ON away.id = g.away_team_id
         WHERE bs.player_id = ?
         ORDER BY g.date ASC`
      )
      .all(playerId)
  );

  ipcMain.handle('db:get-team-game-log', (_event, teamId) =>
    db
      .prepare(
        `SELECT g.id AS game_id, g.date AS date,
                CASE WHEN g.home_team_id = ? THEN away.name ELSE home.name END AS opponent,
                SUM(bs.min) AS min, SUM(bs.pts) AS pts, SUM(bs.fgm) AS fgm, SUM(bs.fga) AS fga,
                SUM(bs.tpm) AS tpm, SUM(bs.tpa) AS tpa, SUM(bs.ftm) AS ftm, SUM(bs.fta) AS fta,
                SUM(bs.oreb) AS oreb, SUM(bs.dreb) AS dreb, SUM(bs.ast) AS ast,
                SUM(bs.stl) AS stl, SUM(bs.blk) AS blk, SUM(bs.tov) AS tov, SUM(bs.pf) AS pf
         FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         JOIN games g ON g.id = bs.game_id
         JOIN teams home ON home.id = g.home_team_id
         JOIN teams away ON away.id = g.away_team_id
         WHERE p.team_id = ?
         GROUP BY g.id
         ORDER BY g.date ASC`
      )
      .all(teamId, teamId)
  );
}

function teamAggregate(db, teamId) {
  const rows = db
    .prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE p.team_id = ?`)
    .all(teamId);
  return { rows, totals: sumRows(rows), games: new Set(rows.map((r) => r.game_id)).size };
}

/**
 * For every game `teamId` played, the *other* team's box-score rows —
 * "boards/possessions available to the opponent", the missing half of
 * every rebounding %, steal %, block %, and PIE formula. Uses
 * `games.home_team_id`/`away_team_id` to find, for each of the team's
 * games, whichever side it wasn't on.
 */
function opponentAggregate(db, teamId) {
  const rows = db
    .prepare(
      `SELECT bs.*
       FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN games g ON g.id = bs.game_id
       WHERE (g.home_team_id = ? AND p.team_id = g.away_team_id)
          OR (g.away_team_id = ? AND p.team_id = g.home_team_id)`
    )
    .all(teamId, teamId);
  return { rows, totals: sumRows(rows), games: new Set(rows.map((r) => r.game_id)).size };
}

/**
 * Every box score row for every team in a league, all-time (not
 * season-scoped) — used as the PER/impact-score baseline for player and
 * team views. `teamGames` counts distinct (game, team) pairs rather than
 * distinct games, since a real game contributes two teams' worth of stats
 * to `totals` — see the comment on statsEngine's `per()`.
 */
function leagueAggregate(db, leagueId) {
  const rows = db
    .prepare(
      `SELECT bs.*, t.id AS team_id
       FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN teams t ON t.id = p.team_id
       WHERE t.league_id = ?`
    )
    .all(leagueId);
  return {
    rows,
    totals: sumRows(rows),
    games: new Set(rows.map((r) => r.game_id)).size,
    teamGames: new Set(rows.map((r) => `${r.game_id}:${r.team_id}`)).size,
  };
}

/**
 * Full StatSummary — totals/perGame/advanced (scoring, shooting, rebounding
 * %, ball-handling %) plus PER, the BPM-style impact score, and PIE.
 *
 * `isTeam` picks team-level vs individual formulas for the stats that need
 * it (rebounding %, ball-handling %) — a team's own formulas are plain
 * share-of-available ratios, an individual's are the classic Dean Oliver
 * box-score approximation prorated by team minutes (see statsEngine.js).
 * `oppAgg` is the opponent's aggregate across the subject's games (see
 * `opponentAggregate`) — without it, rebounding/steal/block/PIE can't be
 * computed, since those all need "boards/possessions available", not just
 * the subject's own totals.
 * `perGameDivisor` overrides what `perGame`/totals-derived rates divide by
 * — defaults to `games`, but a league-wide aggregate needs `teamGames`
 * instead (its totals already sum both teams per game — see the /2 fix on
 * `db:get-league-averages`).
 */
function buildStatSummary({ rows, games, isTeam, teamAgg, oppAgg, leagueAgg, perGameDivisor }) {
  const totals = sumRows(rows);
  const divisor = perGameDivisor ?? games;
  const perGameAvg = perGame(totals, divisor || 1);
  const advanced = {
    ...advancedStatLine(totals),
    ...reboundingStatLine({ row: totals, teamRow: teamAgg.totals, oppRow: oppAgg.totals, isTeam }),
    ...ballHandlingStatLine({ row: totals, teamRow: teamAgg.totals, oppRow: oppAgg.totals, isTeam }),
  };

  const leagueDivisor = leagueAgg.teamGames || leagueAgg.games || 1;
  const leaguePerGameAvg = perGame(leagueAgg.totals, leagueDivisor);
  const leagueAdvanced = advancedStatLine(leagueAgg.totals);

  return {
    games,
    totals,
    perGame: perGameAvg,
    advanced,
    per: computePER({
      playerTotals: totals,
      teamTotals: teamAgg.totals,
      teamGames: teamAgg.games || 1,
      leagueTotals: leagueAgg.totals,
      leagueTeamGames: leagueAgg.teamGames || 1,
    }),
    impact: impactScore(perGameAvg, leaguePerGameAvg, advanced.ts_pct, leagueAdvanced.ts_pct),
    pie: computePIE(totals, teamAgg.totals, oppAgg.totals),
  };
}

/**
 * A lighter StatSummary for cross-league combined totals — PER/impact/PIE
 * and the team/opponent-dependent advanced stats (rebounding %, ball-
 * handling %) all need one coherent league/opponent context to normalize
 * against, which a "combined across every competition" row doesn't have,
 * so those come back null here. Totals, per-game, and the self-contained
 * scoring/shooting line are still valid to sum across competitions.
 */
function buildCombinedSummary(rows, games) {
  const totals = sumRows(rows);
  return {
    games,
    totals,
    perGame: perGame(totals, games || 1),
    advanced: {
      ...advancedStatLine(totals),
      oreb_pct: null,
      dreb_pct: null,
      treb_pct: null,
      ast_pct: null,
      tov_pct: null,
      stl_pct: null,
      blk_pct: null,
      usg_pct: null,
    },
    per: null,
    impact: null,
    pie: null,
  };
}

function leagueSeasonRows(db, leagueId, seasonId) {
  return db
    .prepare(
      `SELECT bs.*, t.id AS team_id, t.name AS team_name
       FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN teams t ON t.id = p.team_id
       JOIN games g ON g.id = bs.game_id
       WHERE t.league_id = ? AND g.season_id = ?`
    )
    .all(leagueId, seasonId);
}

function insertRoster(db, gameId, teamId, players) {
  for (const p of players) {
    const playerId = upsertPlayer(db, p.name, teamId);
    db.prepare(
      `INSERT INTO box_scores
         (game_id, player_id, min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pfd, plus_minus)
       VALUES
         (@gameId, @playerId, @min, @pts, @fgm, @fga, @tpm, @tpa, @ftm, @fta, @oreb, @dreb, @ast, @stl, @blk, @tov, @pf, @pfd, @plus_minus)`
    ).run({ gameId, playerId, pfd: 0, plus_minus: 0, ...p });
  }
}

function upsertTeam(db, name, leagueId) {
  const existing = db.prepare(`SELECT id FROM teams WHERE name = ? AND league_id = ?`).get(name, leagueId);
  if (existing) return existing.id;
  return db.prepare(`INSERT INTO teams (league_id, name) VALUES (?, ?)`).run(leagueId, name).lastInsertRowid;
}

function upsertPlayer(db, name, teamId) {
  const existing = db.prepare(`SELECT id FROM players WHERE name = ? AND team_id = ?`).get(name, teamId);
  if (existing) return existing.id;
  return db.prepare(`INSERT INTO players (team_id, name) VALUES (?, ?)`).run(teamId, name).lastInsertRowid;
}

module.exports = { registerIpcHandlers };
