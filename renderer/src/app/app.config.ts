import { ApplicationConfig, ErrorHandler, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideCharts, withDefaultRegisterables } from 'ng2-charts';
import { createErrorHandler } from '@sentry/angular';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideCharts(withDefaultRegisterables()),
    // A no-op ErrorHandler when Sentry was never initialized (empty DSN) —
    // createErrorHandler() only reports if Sentry.init() has already run.
    { provide: ErrorHandler, useValue: createErrorHandler() },
  ],
};
