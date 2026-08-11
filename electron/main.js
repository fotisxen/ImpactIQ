const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { registerIpcHandlers } = require('./ipc');
const { initDb } = require('./db');

const DEEP_LINK_PROTOCOL = 'boxscore-analytics';

// electron-builder picks up build/icon.png (Windows/Linux) or build/icon.icns
// (macOS) automatically for the packaged app — this just also sets it on the
// live BrowserWindow (title bar / taskbar) during `npm run dev`. Guarded
// since the file only needs to exist once the app icon has actually been
// added.
const APP_ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    backgroundColor: '#0b0e14',
    ...(fs.existsSync(APP_ICON_PATH) ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools();
  } else {
    // Production build output of the Angular renderer.
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'renderer', 'browser', 'index.html'));
  }
}

/**
 * Registers this app as the handler for boxscore-analytics:// links, which
 * is where Stripe Checkout / the Billing Portal redirect back to once the
 * user finishes in their system browser (see supabase/functions —
 * success_url/cancel_url/return_url all point here).
 */
function registerDeepLinkProtocol() {
  if (process.defaultApp) {
    // Running unpackaged (`electron .`) — the OS needs the exact
    // electron.exe + script path to relaunch, or the association silently
    // fails. Packaged builds don't need the extra args.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
  }
}

function extractDeepLink(argv) {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_PROTOCOL}://`));
}

function handleDeepLink(url) {
  if (!mainWindow || !url) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  const { status } = Object.fromEntries(new URL(url).searchParams);
  mainWindow.webContents.send('deep-link:checkout', status || null);
}

registerDeepLinkProtocol();

// Windows/Linux deliver the deep link either as argv on a cold start, or
// via 'second-instance' if the app was already running — hence the lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    handleDeepLink(extractDeepLink(argv));
  });

  // macOS delivers it as its own event instead of argv.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(() => {
    const db = initDb();
    createWindow();
    registerIpcHandlers(db, mainWindow);

    const coldStartLink = extractDeepLink(process.argv);
    if (coldStartLink) mainWindow.webContents.once('did-finish-load', () => handleDeepLink(coldStartLink));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
