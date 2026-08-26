/**
 * Short definitions for stat-tile labels, keyed by the exact label text
 * already used at each `<app-stat-tile>` call site — so `StatTileComponent`
 * can look one up from its own `label()` input with zero changes needed at
 * any of the ~80 existing call sites across Dashboard and Four Factors.
 */
export const STAT_GLOSSARY: Record<string, string> = {
  PIR: 'Performance Index Rating — a single all-in-one box-score rating (positives minus negatives), the FIBA/EuroLeague equivalent of an efficiency score.',
  PER: "Player Efficiency Rating — a per-minute rating of overall production, normalized so a league-average player scores around 15.",
  'Impact Score': "This app's own blended rating combining scoring efficiency and per-game production relative to the league average.",
  PIE: "Player Impact Estimate — the share of the game's total statistical production (points, rebounds, assists, etc.) credited to this player or team, out of both teams combined.",
  'Net Rating': 'Point differential per 100 possessions — offensive rating minus defensive rating.',
  'PTS / game': 'Total points scored, divided by games played.',
  PPFT: 'Points Per Field-goal-and-free-throw Trip — points scored per scoring opportunity, blending shooting and free-throw efficiency into one number.',
  PP2PS: 'Points Per 2-Point Shot attempted.',
  PP3PS: 'Points Per 3-Point Shot attempted.',
  'Points / Shot': 'Points scored per field-goal attempt (2s and 3s combined).',
  'Points / Poss': 'Points scored per individual possession used.',
  'Points / 100 Poss': 'Points scored per 100 possessions — the same points-per-possession rate, scaled to a full game for easier comparison.',
  FTr: 'Free Throw Rate — free throws attempted per field-goal attempt, a measure of how often a player/team gets to the line.',
  '3PAr': '3-Point Attempt Rate — the share of field-goal attempts that are 3-pointers.',
  'eFG%': 'Effective Field Goal % — field-goal percentage adjusted to give 3-pointers 1.5x the weight of a 2-pointer, since they\'re worth 50% more.',
  'TS%': 'True Shooting % — overall scoring efficiency accounting for 2s, 3s, and free throws together in one number.',
  'OREB%': 'Offensive Rebound % — the share of available offensive rebounds actually grabbed.',
  'DREB%': 'Defensive Rebound % — the share of available defensive rebounds actually grabbed.',
  'TRB%': 'Total Rebound % — the share of all available rebounds (both ends) actually grabbed.',
  'AST%': 'Assist % — the share of teammates\' made field goals this player assisted on while on the floor.',
  'STL%': 'Steal % — the share of opponent possessions ended by a steal.',
  'BLK%': 'Block % — the share of opponent 2-point attempts blocked while on the floor.',
  'TOV%': 'Turnover % — turnovers per 100 plays used. Lower is better.',
  'AST/TOV': 'Assist-to-turnover ratio — ball security relative to playmaking.',
  'STL/TOV': 'Steal-to-turnover ratio.',
  'USG%': 'Usage % — the share of team possessions used by this player while on the floor (shots, free throws, and turnovers).',
  ORtg: 'Offensive Rating — points scored per 100 possessions.',
  DRtg: 'Defensive Rating — points allowed per 100 possessions. Lower is better.',
  Pace: 'Estimated possessions per game — how fast a team plays.',
  'Opponent Quality (avg. opponent Net Rating)': "The average Net Rating of every opponent faced this season — a measure of strength of schedule, not individual matchup difficulty.",
  'Assisted FG%': 'The share of made field goals that came off an assist, from play-by-play data.',
  'Live-ball TOV%': 'The share of turnovers that were live-ball (steals, bad passes) rather than dead-ball (offensive fouls, out of bounds) — live-ball turnovers are more costly since they can be run back the other way immediately.',
  'Opponent ORB%': "The opponent's offensive rebound % against this team — the flip side of this team's own defensive rebounding.",
  'FT/FGA': 'Free throws made per field-goal attempt — a simpler cousin of Free Throw Rate.',
  'Foul Rate (PF/game)': 'Personal fouls committed per game.',
  '3P Attempt Rate': 'The share of field-goal attempts that are 3-pointers.',
};
