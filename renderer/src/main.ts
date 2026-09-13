import { init as sentryInit } from '@sentry/electron/renderer';
import { init as angularInit } from '@sentry/angular';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// No-op when preload.js exposed an empty DSN (SENTRY_DSN not set in .env).
if (window.__SENTRY_DSN__) {
  sentryInit({ dsn: window.__SENTRY_DSN__, tracesSampleRate: 0.1 }, angularInit);
}

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
