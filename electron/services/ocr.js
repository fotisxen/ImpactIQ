const PLAYER_LINE_SHAPE = `{
      "name": string,
      "min": number,      // minutes played, decimal ok
      "pts": number,
      "fgm": number, "fga": number,
      "tpm": number, "tpa": number,
      "ftm": number, "fta": number,
      "oreb": number, "dreb": number,
      "ast": number, "stl": number, "blk": number,
      "tov": number, "pf": number, "pfd": number,
      "plus_minus": number  // net point differential while on court; 0 if not printed on the box score
    }`;

const EXTRACTION_SYSTEM_PROMPT = `You extract basketball box scores from photographed or screenshotted tables.
Box score photos almost always show BOTH teams' full stat lines (either
stacked vertically with a team-name header row, or side by side) — extract
both, not just one.

Return ONLY valid JSON (no markdown fences, no prose) matching exactly this shape:

{
  "team": string,
  "opponent": string,
  "date": string,        // ISO format if visible, otherwise best guess, otherwise ""
  "players": [${PLAYER_LINE_SHAPE}],
  "opponentPlayers": [${PLAYER_LINE_SHAPE}]
}

"players" is the first/top team's roster, "opponentPlayers" is the
second/bottom team's roster. "team" and "opponent" are those two teams'
names respectively, read from the image.

Rules:
- If a column is genuinely not present in the image, use 0 for that stat rather than guessing.
- Do not invent players. Only include rows that are clearly player stat lines.
- If FGM/FGA or 3PM/3PA are combined like "5-12" in one cell, split them into the two numeric fields.
- Never include totals/team rows as a "player".
- If only one team's stats are visible in the image, still return the shape above with "opponentPlayers" as an empty array.`;

/**
 * Calls the Claude API to OCR a box score image into structured JSON.
 * Runs entirely in the main process so the API key never touches the renderer.
 *
 * @param {string} base64Image - raw base64 (no data: prefix)
 * @param {string} mediaType - e.g. 'image/jpeg' | 'image/png'
 * @returns {Promise<object>} parsed box score object
 */
async function extractBoxScore(base64Image, mediaType = 'image/jpeg') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key configured — return a canned example so the rest of the
    // app (review table, save, stats, export) is fully demoable without
    // wiring up billing. Remove this branch once ANTHROPIC_API_KEY is set.
    return demoBoxScore();
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            { type: 'text', text: 'Extract this box score as JSON.' },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((block) => block.type === 'text');
  if (!textBlock) throw new Error('No text response from OCR call.');

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse OCR response as JSON: ${err.message}\nRaw: ${cleaned}`);
  }
}

/**
 * Demo data returned when ANTHROPIC_API_KEY isn't set, so the upload ->
 * review -> save -> stats -> export flow can be tried end to end without
 * any API billing configured. A small delay simulates the real call.
 */
function demoBoxScore() {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        team: 'Iraklis',
        opponent: 'PAOK',
        date: new Date().toISOString().slice(0, 10),
        players: [
          { name: 'G. Papadopoulos', min: 32, pts: 24, fgm: 9, fga: 15, tpm: 2, tpa: 5, ftm: 4, fta: 4, oreb: 1, dreb: 5, ast: 6, stl: 2, blk: 0, tov: 3, pf: 2, pfd: 5, plus_minus: 12 },
          { name: 'N. Antoniou', min: 28, pts: 14, fgm: 5, fga: 11, tpm: 1, tpa: 4, ftm: 3, fta: 3, oreb: 2, dreb: 4, ast: 2, stl: 1, blk: 1, tov: 2, pf: 3, pfd: 3, plus_minus: 6 },
          { name: 'K. Ioannidis', min: 24, pts: 9, fgm: 4, fga: 8, tpm: 0, tpa: 1, ftm: 1, fta: 2, oreb: 3, dreb: 6, ast: 1, stl: 0, blk: 2, tov: 1, pf: 4, pfd: 2, plus_minus: 4 },
          { name: 'D. Michailidis', min: 19, pts: 6, fgm: 2, fga: 6, tpm: 2, tpa: 4, ftm: 0, fta: 0, oreb: 0, dreb: 2, ast: 3, stl: 1, blk: 0, tov: 1, pf: 1, pfd: 1, plus_minus: -2 },
          { name: 'A. Stavrou', min: 16, pts: 4, fgm: 2, fga: 3, tpm: 0, tpa: 0, ftm: 0, fta: 0, oreb: 1, dreb: 1, ast: 1, stl: 0, blk: 0, tov: 0, pf: 2, pfd: 1, plus_minus: -4 },
        ],
        opponentPlayers: [
          { name: 'V. Georgiou', min: 30, pts: 19, fgm: 7, fga: 14, tpm: 3, tpa: 6, ftm: 2, fta: 2, oreb: 0, dreb: 4, ast: 4, stl: 1, blk: 0, tov: 2, pf: 3, pfd: 4, plus_minus: -10 },
          { name: 'T. Karagiannis', min: 27, pts: 12, fgm: 5, fga: 10, tpm: 0, tpa: 2, ftm: 2, fta: 3, oreb: 3, dreb: 5, ast: 1, stl: 2, blk: 1, tov: 1, pf: 2, pfd: 2, plus_minus: -6 },
          { name: 'M. Dimitriou', min: 22, pts: 8, fgm: 3, fga: 7, tpm: 1, tpa: 3, ftm: 1, fta: 2, oreb: 1, dreb: 3, ast: 2, stl: 0, blk: 0, tov: 2, pf: 4, pfd: 1, plus_minus: -4 },
          { name: 'S. Vasileiou', min: 18, pts: 7, fgm: 3, fga: 5, tpm: 0, tpa: 1, ftm: 1, fta: 2, oreb: 2, dreb: 2, ast: 1, stl: 1, blk: 1, tov: 0, pf: 1, pfd: 1, plus_minus: 2 },
          { name: 'P. Nikolaou', min: 15, pts: 3, fgm: 1, fga: 4, tpm: 1, tpa: 2, ftm: 0, fta: 0, oreb: 0, dreb: 1, ast: 2, stl: 0, blk: 0, tov: 1, pf: 2, pfd: 0, plus_minus: -2 },
        ],
      });
    }, 900);
  });
}

module.exports = { extractBoxScore };
