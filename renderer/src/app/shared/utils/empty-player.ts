import { PlayerBoxScore } from '../../core/models/box-score.model';

export function emptyPlayer(): PlayerBoxScore {
  return {
    name: '', min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
    oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, pfd: 0, plus_minus: 0, srj: 0,
  };
}
