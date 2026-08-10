import { Injectable, signal } from '@angular/core';
import { ExtractedBoxScore, PlayerBoxScore } from '../../core/models/box-score.model';
import { emptyPlayer } from '../../shared/utils/empty-player';

function emptyBoxScore(): ExtractedBoxScore {
  return {
    team: '',
    opponent: '',
    date: new Date().toISOString().slice(0, 10),
    players: [emptyPlayer()],
    opponentPlayers: [emptyPlayer()],
  };
}

type RosterField = 'players' | 'opponentPlayers';

@Injectable({ providedIn: 'root' })
export class ManualEntryService {
  readonly boxScore = signal<ExtractedBoxScore>(emptyBoxScore());

  setHeader(field: 'team' | 'opponent' | 'date', value: string): void {
    this.boxScore.update((current) => ({ ...current, [field]: value }));
  }

  setRoster(field: RosterField, roster: PlayerBoxScore[]): void {
    this.boxScore.update((current) => ({ ...current, [field]: roster }));
  }

  addPlayerRow(field: RosterField): void {
    this.boxScore.update((current) => ({
      ...current,
      [field]: [...current[field], emptyPlayer()],
    }));
  }

  removePlayerRow(field: RosterField, index: number): void {
    this.boxScore.update((current) => ({
      ...current,
      [field]: current[field].filter((_, i) => i !== index),
    }));
  }

  reset(): void {
    this.boxScore.set(emptyBoxScore());
  }
}
