import { Injectable, signal } from '@angular/core';
import { PbpExtractedBoxScore } from '../../core/models/box-score.model';
import { friendlyErrorMessage } from '../../shared/utils/error-message';

@Injectable({ providedIn: 'root' })
export class PbpImportService {
  readonly extracting = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<PbpExtractedBoxScore | null>(null);
  readonly fileName = signal<string | null>(null);

  async extractFromFile(file: File): Promise<void> {
    this.fileName.set(file.name);
    this.extracting.set(true);
    this.error.set(null);
    this.result.set(null);

    try {
      const base64 = await this.fileToBase64(file);
      const extracted = await window.boxscoreApi.extractPlayByPlay(base64);
      this.result.set(extracted);
    } catch (err) {
      this.error.set(friendlyErrorMessage(err, 'Could not read that file as play-by-play data.'));
    } finally {
      this.extracting.set(false);
    }
  }

  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.readAsDataURL(file);
    });
  }
}
