import { Injectable, computed, signal } from '@angular/core';
import { ExtractedBoxScore } from '../../core/models/box-score.model';

@Injectable({ providedIn: 'root' })
export class UploadService {
  readonly extracting = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<ExtractedBoxScore | null>(null);
  readonly previewUrl = signal<string | null>(null);
  readonly secondPreviewUrl = signal<string | null>(null);

  /** True once a first extraction came back with only one team's roster filled in. */
  readonly needsSecondPhoto = computed(() => {
    const r = this.result();
    return r !== null && (r.players.length === 0 || r.opponentPlayers.length === 0);
  });

  async extractFromFile(file: File): Promise<void> {
    this.setPreview(file);
    this.clearSecondPreview();
    this.extracting.set(true);
    this.error.set(null);
    this.result.set(null);

    try {
      const base64 = await this.fileToBase64(file);
      const extracted = await window.boxscoreApi.extractBoxScore(base64, file.type);
      this.result.set(extracted);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'OCR extraction failed.');
    } finally {
      this.extracting.set(false);
    }
  }

  /**
   * For when one photo only captured one team's stat line — reads a
   * second photo and fills in whichever roster is still empty, instead of
   * starting the whole extraction over. If the "empty" side turns out to
   * already be filled by the time this resolves, this fills the opponent
   * side, since needing a second photo at all almost always means "here's
   * the other team."
   */
  async extractSecondTeamFromFile(file: File): Promise<void> {
    const current = this.result();
    if (!current) return;

    this.setSecondPreview(file);
    this.extracting.set(true);
    this.error.set(null);

    try {
      const base64 = await this.fileToBase64(file);
      const extracted = await window.boxscoreApi.extractBoxScore(base64, file.type);
      const existing = this.result() ?? current;
      if (existing.players.length === 0) {
        this.result.set({ ...existing, team: extracted.team, players: extracted.players });
      } else {
        this.result.set({ ...existing, opponent: extracted.team, opponentPlayers: extracted.players });
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'OCR extraction failed.');
    } finally {
      this.extracting.set(false);
    }
  }

  private setPreview(file: File): void {
    const previous = this.previewUrl();
    if (previous) URL.revokeObjectURL(previous);
    this.previewUrl.set(URL.createObjectURL(file));
  }

  private setSecondPreview(file: File): void {
    const previous = this.secondPreviewUrl();
    if (previous) URL.revokeObjectURL(previous);
    this.secondPreviewUrl.set(URL.createObjectURL(file));
  }

  private clearSecondPreview(): void {
    const previous = this.secondPreviewUrl();
    if (previous) URL.revokeObjectURL(previous);
    this.secondPreviewUrl.set(null);
  }

  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip the "data:image/jpeg;base64," prefix — main process only wants raw base64.
        resolve(result.split(',')[1]);
      };
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.readAsDataURL(file);
    });
  }
}
