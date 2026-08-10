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
function getSupabaseClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY (see .env.example).'
    );
  }

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
