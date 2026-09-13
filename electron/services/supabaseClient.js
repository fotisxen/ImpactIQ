const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { app } = require('electron');
const { createClient } = require('@supabase/supabase-js');

let client = null;

function sessionFilePath() {
  return path.join(app.getPath('userData'), 'supabase-session.json');
}

/**
 * Minimal on-disk storage adapter for the Supabase auth session. Without
 * this, the client would be stateless — every call after login() would run
 * as an anonymous request (auth.uid() = null), which silently returns
 * empty results from every RLS-protected table instead of erroring. Also
 * means the user doesn't have to log back in on every app launch.
 */
const fileStorage = {
  getItem(key) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionFilePath(), 'utf-8'));
      return data[key] ?? null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(sessionFilePath(), 'utf-8'));
    } catch {
      // No session file yet — start fresh.
    }
    data[key] = value;
    fs.writeFileSync(sessionFilePath(), JSON.stringify(data));
  },
  removeItem(key) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionFilePath(), 'utf-8'));
      delete data[key];
      fs.writeFileSync(sessionFilePath(), JSON.stringify(data));
    } catch {
      // Nothing to remove.
    }
  },
};

/**
 * Lazily-created singleton Supabase client for the Electron main process.
 * Reads the project URL + anon key from the environment (see .env.example).
 * The anon key is safe to ship in a desktop build — every table it can
 * touch is protected by Row Level Security policies in the Supabase
 * project, not by keeping this key secret.
 */
// Safe to ship hardcoded in a packaged build: this is the anon/publishable
// key, not a secret — every table it can touch is protected by Row Level
// Security, the same way a web app's Supabase client key is always public.
// `.env` isn't bundled into the packaged app (see package.json's build.files),
// so without this fallback a packaged build would fail at first launch with
// "Supabase is not configured" — `.env` (when present, e.g. during `npm run
// dev`) still takes priority, so nothing changes for local development.
const FALLBACK_SUPABASE_URL = 'https://wnuhfyjmesurylehejwy.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_y7ZIrF5o5U1qc7d1ni1nHA_zqAMeHsv';

function getSupabaseClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL || FALLBACK_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || FALLBACK_SUPABASE_ANON_KEY;

  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: fileStorage,
    },
    // Electron bundles an older Node with no global WebSocket — the
    // realtime module needs one even though this app never opens a
    // realtime channel, so it's supplied via `ws` rather than left unset.
    realtime: {
      transport: WebSocket,
    },
  });

  return client;
}

module.exports = { getSupabaseClient };
