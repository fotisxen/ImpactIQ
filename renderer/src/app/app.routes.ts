import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { photoTierGuard, entryTierGuard, platformAdminGuard } from './core/subscription/tier.guard';

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
        canActivate: [photoTierGuard],
        loadComponent: () =>
          import('./features/upload/upload.component').then((m) => m.UploadComponent),
      },
      {
        path: 'import-pbp',
        canActivate: [entryTierGuard],
        loadComponent: () =>
          import('./features/import-pbp/import-pbp.component').then((m) => m.ImportPbpComponent),
      },
      {
        path: 'manual-entry',
        canActivate: [entryTierGuard],
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
        path: 'compare',
        loadComponent: () =>
          import('./features/compare/compare.component').then((m) => m.CompareComponent),
      },
      {
        path: 'scouting',
        loadComponent: () =>
          import('./features/scouting/scouting.component').then((m) => m.ScoutingComponent),
      },
      {
        path: 'draw',
        loadComponent: () => import('./features/draw/draw.component').then((m) => m.DrawComponent),
      },
      {
        path: 'account',
        loadComponent: () =>
          import('./features/account/account.component').then((m) => m.AccountComponent),
      },
      {
        path: 'admin',
        canActivate: [platformAdminGuard],
        loadComponent: () => import('./features/admin/admin.component').then((m) => m.AdminComponent),
      },
    ],
  },
];
