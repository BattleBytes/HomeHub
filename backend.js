import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const configured = Boolean(url && key);
const supabase = configured ? createClient(url, key, {
  auth: { flowType: 'pkce', detectSessionInUrl: true }
}) : null;
let channel;

export function observeSession(handle) {
  return supabase.auth.onAuthStateChange((event, session) => {
    // Leave the auth callback before starting any Supabase operations.
    setTimeout(() => handle(session?.user ?? null, event), 0);
  });
}

export async function sendCode(email) {
  const {error} = await supabase.auth.signInWithOtp({email, options:{shouldCreateUser:true}});
  if (error) throw error;
}

export async function verifyCode(email, token) {
  const {error} = await supabase.auth.verifyOtp({email, token, type:'email'});
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

export function watchChanges(uid, refresh) {
  if (channel) {
    const previous = channel;
    channel = null;
    void supabase.removeChannel(previous);
  }
  if (!uid) return;
  channel = supabase.channel('homehub-changes:' + uid)
    .on('postgres_changes', {event:'*', schema:'public', table:'homehub_events', filter:'uid=eq.' + uid}, refresh)
    .subscribe(status => { if (status === 'SUBSCRIBED') refresh(); });
}

const itemOperations = {POST:'item_add',PATCH:'item_edit',DELETE:'item_delete'};
const taskOperations = {POST:'task_add',PATCH:'task_edit',DELETE:'task_delete'};
const contactOperations = {POST:'contact_add',PATCH:'contact_edit',DELETE:'contact_delete'};

export async function api(path, method='GET', body={}) {
  const [household, action, record] = path.replace(/^\/api\/households\/?/, '').split('/').map(decodeURIComponent);
  const operation = !household ? (method === 'GET' ? 'list' : 'create')
    : household === 'join' ? 'join'
    : !action ? 'get'
    : action === 'items' ? itemOperations[method]
    : action === 'tasks' ? taskOperations[method]
    : action === 'contacts' ? contactOperations[method]
    : action === 'invite' && method === 'DELETE' ? 'revoke'
    : action === 'members' ? (method === 'PATCH' ? 'role' : 'remove')
    : action;
  const {data,error,status} = await supabase.rpc('homehub',{
    p_operation:operation,p_household: household && household !== 'join' ? household : null,
    p_record:record || null,p_body:body
  });
  if (error || data?.error) {
    const denied = status === 401 || error?.code === '42501';
    const failure = new Error(data?.error || (denied ? 'Sign in to continue.' : 'HomeHub could not reach the server. Try again.'));
    failure.status = data?.status || (denied ? 401 : status);
    throw failure;
  }
  return data;
}
