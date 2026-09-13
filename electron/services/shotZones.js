/**
 * Pure aggregation over already-stored `shot_zones` rows (see schema.sql) —
 * no DB access here, just the shape a shot chart needs: per-zone FG%,
 * frequency share of total attempts, and a hot/cold classification using
 * the same thresholds the source scouting template itself uses.
 */
const ZONES = ['at_rim', 'mid_range', 'corner_3', 'wing_3', 'top_key_3'];

// { zone: { hot: fgPct threshold, cold: fgPct threshold, hotFreq, coldFreq } }
// Frequency thresholds classify how often a zone is shot from (share of all attempts).
const THRESHOLDS = {
  at_rim: { hotPct: 0.65, coldPct: 0.25, hotFreq: 0.25, coldFreq: 0.05 },
  mid_range: { hotPct: 0.25, coldPct: 0.1, hotFreq: 0.25, coldFreq: 0.1 },
  corner_3: { hotPct: 0.2, coldPct: 0.05, hotFreq: 0.2, coldFreq: 0.05 },
  wing_3: { hotPct: 0.2, coldPct: 0.05, hotFreq: 0.2, coldFreq: 0.05 },
  top_key_3: { hotPct: 0.2, coldPct: 0.05, hotFreq: 0.2, coldFreq: 0.05 },
};

/** rows: [{ zone, fgm, fga }, ...] — one row per zone (already summed if multiple source rows existed). */
function buildZoneChart(rows) {
  const byZone = new Map(ZONES.map((z) => [z, { zone: z, fgm: 0, fga: 0 }]));
  for (const r of rows) {
    const entry = byZone.get(r.zone);
    if (entry) {
      entry.fgm += r.fgm;
      entry.fga += r.fga;
    }
  }
  const totalFga = [...byZone.values()].reduce((sum, z) => sum + z.fga, 0);

  return ZONES.map((zone) => {
    const z = byZone.get(zone);
    const fgPct = z.fga > 0 ? z.fgm / z.fga : null;
    const frequency = totalFga > 0 ? z.fga / totalFga : null;
    const t = THRESHOLDS[zone];
    let heat = 'neutral';
    if (fgPct !== null) {
      if (fgPct >= t.hotPct) heat = 'hot';
      else if (fgPct <= t.coldPct) heat = 'cold';
    }
    return { zone, fgm: z.fgm, fga: z.fga, fgPct, frequency, heat };
  });
}

module.exports = { ZONES, buildZoneChart };
