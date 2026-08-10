import { Injectable, inject } from '@angular/core';
import { ExtractedBoxScore, StatSummary } from '../../core/models/box-score.model';
import { ToastService } from './toast.service';

@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly toast = inject(ToastService);

  async exportToExcel(payload: ExtractedBoxScore | StatSummary, suggestedName: string): Promise<void> {
    const result = await window.boxscoreApi.exportExcel(payload, suggestedName);
    if (result.saved) this.toast.success(`Saved to ${result.filePath}`);
  }
}
