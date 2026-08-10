const { getSupabaseClient } = require('./supabaseClient');

/**
 * `profile` fields are stored as auth user_metadata at signup time; the
 * `on_auth_user_created` trigger in the Supabase project copies them into
 * `public.profiles` automatically (see supabase/migrations).
 */
async function signup(email, password, profile = {}) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        first_name: profile.firstName || '',
        last_name: profile.lastName || '',
        birth_date: profile.birthDate || null,
        role: profile.role || null,
        organization_id: profile.organizationId || null,
      },
    },
  });
  if (error) throw new Error(error.message);
  // Supabase always returns `data.user` (even before it's confirmed) —
  // `data.session` is the real signal for "signed in and ready to use the
  // app." With email confirmation on (the project default), session is
  // null until the user clicks the emailed link, and the app must not
  // treat this as a working login: nothing gets persisted, so every later
  // Supabase call from the main process would silently run unauthenticated.
  if (!data.session) {
    throw new Error(
      'Account created — check your email to confirm it, then log in. (Or turn off "Confirm email" in Supabase Auth settings while testing.)'
    );
  }
  return { id: data.user.id, email: data.user.email };
}

async function login(email, password) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return { id: data.user.id, email: data.user.email };
}

async function logout() {
  const supabase = getSupabaseClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

module.exports = { signup, login, logout };
