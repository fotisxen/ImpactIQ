import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'signup',
    loadComponent: () => import('./features/auth/signup.component').then((m) => m.SignupComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./core/layout/app-shell.component').then((m) => m.AppShellComponent),
    children: [
      { path: '', redirectTo: 'home', pathMatch: 'full' },
      {
        path: 'home',
        loadComponent: () => import('./features/home/home.component').then((m) => m.HomeComponent),
      },
      {
        path: 'upload',
        loadComponent: () =>
          import('./features/upload/upload.component').then((m) => m.UploadComponent),
      },
      {
        path: 'import-pbp',
        loadComponent: () =>
          import('./features/import-pbp/import-pbp.component').then((m) => m.ImportPbpComponent),
      },
      {
        path: 'manual-entry',
        loadComponent: () =>
          import('./features/manual-entry/manual-entry.component').then(
            (m) => m.ManualEntryComponent
          ),
      },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'game-insights',
        loadComponent: () =>
          import('./features/game-insights/game-insights.component').then(
            (m) => m.GameInsightsComponent
          ),
      },
      {
        path: 'four-factors',
        loadComponent: () =>
          import('./features/four-factors/four-factors.component').then(
            (m) => m.FourFactorsComponent
          ),
      },
      {
        path: 'account',
        loadComponent: () =>
          import('./features/account/account.component').then((m) => m.AccountComponent),
      },
    ],
  },
];
