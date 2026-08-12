// Requires the Supabase UMD script + config.js to be loaded first.
// Exposes: `sb` (the Supabase client) and `Auth` (login/session helpers).

const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const Auth = {
  usernameToEmail(username) {
    return `${username.toLowerCase().trim()}@examrecords.local`;
  },

  async login(username, password) {
    const email = this.usernameToEmail(username);
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: 'Invalid username or password' };

    const profile = await this.loadProfile(data.user.id);
    if (!profile) {
      await sb.auth.signOut();
      return { ok: false, error: 'Your account exists but has no profile set up. Contact the admin.' };
    }
    localStorage.setItem('exam_profile', JSON.stringify(profile));
    return { ok: true, profile };
  },

  async loadProfile(userId) {
    const { data, error } = await sb.from('profiles').select('*').eq('id', userId).single();
    if (error || !data) return null;
    return data;
  },

  getCachedProfile() {
    const raw = localStorage.getItem('exam_profile');
    return raw ? JSON.parse(raw) : null;
  },

  async requireOrRedirect(loginPage = 'index.html') {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { window.location.href = loginPage; return null; }

    let profile = this.getCachedProfile();
    if (!profile || profile.id !== session.user.id) {
      profile = await this.loadProfile(session.user.id);
      if (!profile) { window.location.href = loginPage; return null; }
      localStorage.setItem('exam_profile', JSON.stringify(profile));
    }
    return { session, profile };
  },

  async logout() {
    await sb.auth.signOut();
    localStorage.removeItem('exam_profile');
  },

  async changePassword(oldPassword, newPassword) {
    const profile = this.getCachedProfile();
    if (!profile) return { ok: false, error: 'Not signed in' };
    if (newPassword.length < 6) return { ok: false, error: 'New password must be at least 6 characters' };

    const email = this.usernameToEmail(profile.username);
    const { error: reauthErr } = await sb.auth.signInWithPassword({ email, password: oldPassword });
    if (reauthErr) return { ok: false, error: 'Current password is incorrect' };

    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  async callAdminAction(action, payload = {}) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return { ok: false, error: 'Your session has expired — please sign in again.' };

      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/admin-actions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': CONFIG.SUPABASE_ANON_KEY
          },
          body: JSON.stringify({ action, ...payload })
        });
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return res.json();
        }
        if (attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
        return { ok: false, error: `The server returned an unexpected response (HTTP ${res.status}). This usually means the admin-actions Edge Function isn't deployed, or isn't deployed with the latest code — check Supabase → Edge Functions.` };
      }
    } catch (err) {
      return { ok: false, error: `Could not reach the server: ${err.message}. Check your connection and that SUPABASE_URL in config.js is correct.` };
    }
  }
};

const GRADES = ['6', '7', '8'];
const SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
