// Electron apps don't send a browser Origin the way a web app does, but
// the Supabase JS client still triggers a CORS preflight for
// functions.invoke() — these headers keep that from failing.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
