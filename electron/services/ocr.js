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
      "plus_minus": number, // net point differential while on court; 0 if not printed on the box score
      "srj": number  // this player's shot attempts that were blocked (shots rejected); 0 if not printed on the box score
    }`;

const EXTRACTION_SYSTEM_PROMPT = `You extract basketball box scores from photographed or screenshotted tables.
Box score photos almost always show BOTH teams' full stat lines (either
stacked vertically with a team-name header row, or side by side) β€” extract
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
    // No fabricated fallback here on purpose — a coach could save a fake
    // box score believing it came from their real photo.
    throw new Error('Photo upload (OCR) is not configured on this install — contact your administrator.');
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
    let apiMessage = errText;
    try {
      apiMessage = JSON.parse(errText)?.error?.message || errText;
    } catch {
      // Not JSON β€” fall back to the raw text below.
    }
    if (response.status === 429) {
      throw new Error("We're getting rate-limited by the OCR service β€” wait a moment and try again.");
    }
    if (response.status >= 500) {
      throw new Error('The OCR service is temporarily unavailable β€” try again in a bit.');
    }
    throw new Error(`Couldn't read that photo: ${apiMessage}`);
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

module.exports = { extractBoxScore };
