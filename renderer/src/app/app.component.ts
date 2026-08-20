import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  // Injected here (not just in the authenticated app-shell) so the theme attribute is
  // set before any route — including /login and /signup — renders, avoiding a flash.
  private readonly theme = inject(ThemeService);
}
