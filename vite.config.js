import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_SUPABASE_');
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (Boolean(url) !== Boolean(key)) throw new Error('Set both Supabase frontend variables.');
  if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
    throw new Error('Use the HTTPS Supabase project URL.');
  }
  if (key && !/^sb_publishable_[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error('Use a Supabase publishable key (sb_publishable_), never a secret or service-role key.');
  }
  const base = process.env.PAGES_BASE_PATH?.replace(/\/$/, '') || '';
  return {base: base + '/'};
});
