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

// ── MARKS ENTRY UX HELPERS (shared by teacher.js and admin.js) ──────────

// Wires up: Enter-to-next-row keyboard navigation, live max-marks
// validation (red border), and a running "X / Y entered" counter.
function wireMarksTableUX(students, maxMarks, markPrefix, absentPrefix, progressElId) {
  function updateProgress() {
    let filled = 0;
    students.forEach(s => {
      const absentEl = document.getElementById(`${absentPrefix}-${s.id}`);
      const markEl = document.getElementById(`${markPrefix}-${s.id}`);
      if ((absentEl && absentEl.checked) || (markEl && markEl.value !== '')) filled++;
    });
    const el = document.getElementById(progressElId);
    if (el) el.textContent = `${filled} / ${students.length} entered`;
  }

  students.forEach((s, idx) => {
    const input = document.getElementById(`${markPrefix}-${s.id}`);
    const absentEl = document.getElementById(`${absentPrefix}-${s.id}`);
    if (input) {
      input.addEventListener('input', () => {
        const val = parseFloat(input.value);
        input.classList.toggle('invalid', !isNaN(val) && maxMarks != null && val > maxMarks);
        updateProgress();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = students[idx + 1];
        const nextInput = next ? document.getElementById(`${markPrefix}-${next.id}`) : null;
        if (nextInput) nextInput.focus();
      });
    }
    if (absentEl) absentEl.addEventListener('change', updateProgress);
  });
  updateProgress();
}

// Builds and downloads an .xlsx template for a test's marks — one row per
// student, pre-filled with any marks already saved, ready to fill in Excel
// and re-upload.
function downloadMarksTemplate(test, students, marksByStudent) {
  const rows = students.map((s, i) => {
    const existing = marksByStudent[s.id];
    return {
      'Roll': i + 1,
      'Student ID': s.id,
      'Name': s.name,
      'Marks': existing && !existing.is_absent ? (existing.marks_obtained ?? '') : '',
      'Absent (Y/N)': existing && existing.is_absent ? 'Y' : ''
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 24 }, { wch: 24 }, { wch: 8 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Marks');
  const safeName = `${test.name}_${test.grade}-${test.section}`.replace(/[^a-z0-9-]+/gi, '_');
  XLSX.writeFile(wb, `${safeName}_marks_template.xlsx`);
}

// Reads an uploaded .xlsx/.xls/.csv file and returns { studentId: { marks, absent } }.
// Matching is by "Student ID" — the template includes it precisely so a
// re-upload can't be misattributed by a typo'd or duplicate name.
async function parseMarksFile(file) {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const result = {};
  rows.forEach(r => {
    const id = String(r['Student ID'] || '').trim();
    if (!id) return;
    const absent = String(r['Absent (Y/N)'] || '').trim().toUpperCase().startsWith('Y');
    const marksRaw = r['Marks'];
    const marks = absent || marksRaw === '' || marksRaw == null ? null : Number(marksRaw);
    result[id] = { absent, marks };
  });
  return result;
}
