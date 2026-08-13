let profile, subjects = [], subjectClasses = [], houses = [], years = [], fieldDefs = [], pendingAssignments = [], currentYearId = null;

const GRADE_LIST = ['6', '7', '8'];
const SECTION_LIST = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

async function signOut() {
  await Auth.logout();
  window.location.href = 'index.html';
}

async function changePassword() {
  const oldPassword = window.prompt('Enter your current password:');
  if (!oldPassword) return;
  const newPassword = window.prompt('Enter a new password (6+ characters):');
  if (!newPassword) return;
  const res = await Auth.changePassword(oldPassword, newPassword);
  if (!res.ok) { alert(res.error); return; }
  alert('Password updated.');
}

function showTab(name) {
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  const btn = document.querySelector(`.tabs button[data-tab="${name}"]`);
  if (btn) btn.classList.add('active');
  if (name === 'teachers') loadTeachers();
  if (name === 'students') loadStudents();
  if (name === 'fields') loadFields();
}

// ── REUSABLE GRADE/SECTION CHECKBOX GRID ────────────────────────────────
// mode 'multi' = normal checkboxes. mode 'single' = radio-like (checking
// one unchecks the others in that group) — used for the admin role on the
// Tests & Marks page, where super_admin gets full multi-select instead.

function renderCheckGrid(gradeSpanId, sectionSpanId, mode) {
  const gEl = document.getElementById(gradeSpanId);
  const sEl = document.getElementById(sectionSpanId);
  if (!gEl || !sEl) return;
  gEl.innerHTML = GRADE_LIST.map(g => `<label style="margin-right:8px;"><input type="checkbox" class="grid-${gradeSpanId}" value="${g}"> ${g}</label>`).join('');
  sEl.innerHTML = SECTION_LIST.map(s => `<label style="margin-right:8px;"><input type="checkbox" class="grid-${sectionSpanId}" value="${s}"> ${s}</label>`).join('');

  if (mode === 'single') {
    [gradeSpanId, sectionSpanId].forEach(spanId => {
      document.querySelectorAll(`.grid-${spanId}`).forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) document.querySelectorAll(`.grid-${spanId}`).forEach(o => { if (o !== cb) o.checked = false; });
        });
      });
    });
  }
}

function getChecked(spanId) {
  return Array.from(document.querySelectorAll(`.grid-${spanId}:checked`)).map(cb => cb.value);
}

function checkAll(spanId) {
  document.querySelectorAll(`.grid-${spanId}`).forEach(cb => cb.checked = true);
}

// ── SHARED DATA ──────────────────────────────────────────────────────────

async function loadSharedData() {
  const [{ data: subjData }, { data: classData }, { data: houseData }, { data: yearData }, { data: fieldData }] = await Promise.all([
    sb.from('subjects').select('*').order('name'),
    sb.from('subject_classes').select('*'),
    sb.from('houses').select('*').order('name'),
    sb.from('academic_years').select('*').order('label', { ascending: false }),
    sb.from('field_definitions').select('*').order('created_at')
  ]);
  subjects = subjData || [];
  subjectClasses = classData || [];
  houses = houseData || [];
  years = yearData || [];
  fieldDefs = fieldData || [];

  const subjectOptions = subjects.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  const yearOptions = years.map(y => `<option value="${y.id}" ${y.is_current ? 'selected' : ''}>${y.label}</option>`).join('');
  const houseOptions = houses.map(h => `<option value="${h.id}">${h.name}</option>`).join('');

  ['ptSubject', 'tmSubject', 'assignSubject'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = subjectOptions; });
  ['ptYear', 'repYear'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = yearOptions; });
  const repSubjectEl = document.getElementById('repSubject');
  if (repSubjectEl) repSubjectEl.innerHTML = '<option value="">Any subject</option>' + subjectOptions;
  const stuHouseEl = document.getElementById('stuHouse');
  if (stuHouseEl) stuHouseEl.innerHTML = '<option value="">No house</option>' + houseOptions;
  const lbHouseEl = document.getElementById('lbHouse');
  if (lbHouseEl) lbHouseEl.innerHTML = '<option value="">All houses</option>' + houseOptions;

  renderSetupLists();
}

function classesForSubject(subjectId) {
  return subjectClasses.filter(c => c.subject_id === subjectId).map(c => `${c.grade}-${c.section}`);
}

// ── SETUP TAB (super admin only) ─────────────────────────────────────────

function renderSetupLists() {
  document.getElementById('yearsList').innerHTML = years.map(y => `
    <div class="test-row">
      <div>${y.label} ${y.is_current ? '<span class="badge">Current</span>' : ''}</div>
      ${!y.is_current ? `<button class="btn small secondary" onclick="setCurrentYear('${y.id}')">Set as current</button>` : ''}
    </div>`).join('') || '<p class="hint">No academic years yet.</p>';

  document.getElementById('subjectsList').innerHTML = subjects.map(s => `
    <div class="test-row">
      <div>${s.name} <span class="hint">(${classesForSubject(s.id).join(', ') || 'no classes assigned'})</span></div>
      <div style="display:flex; gap:6px;">
        <button class="btn small secondary" onclick="editSubject('${s.id}')">Edit</button>
        <button class="btn small secondary" onclick="deleteSubjectConfirm('${s.id}')">Delete</button>
      </div>
    </div>
    <div id="editSubjectPanel-${s.id}" style="display:none; padding:10px 0;"></div>
  `).join('') || '<p class="hint">No subjects yet.</p>';

  renderCheckGrid('newSubjectGrades', 'newSubjectSections', 'multi');
}

async function addSubject() {
  const name = document.getElementById('newSubjectName').value.trim();
  if (!name) { alert('Enter a subject name'); return; }
  const grades = getChecked('newSubjectGrades');
  const sections = getChecked('newSubjectSections');
  if (!grades.length || !sections.length) { alert('Check at least one grade and one section'); return; }

  const classes = [];
  grades.forEach(g => sections.forEach(s => classes.push({ grade: g, section: s })));

  const { error } = await sb.rpc('create_subject', { p_name: name, p_classes: classes });
  if (error) { alert(error.message); return; }
  document.getElementById('newSubjectName').value = '';
  await loadSharedData();
}

function editSubject(subjectId) {
  const subject = subjects.find(s => s.id === subjectId);
  const panel = document.getElementById(`editSubjectPanel-${subjectId}`);
  const currentClasses = subjectClasses.filter(c => c.subject_id === subjectId);

  panel.innerHTML = `
    <div class="subcard">
      <div class="form-row"><input id="editName-${subjectId}" value="${subject.name}"></div>
      <div class="form-row">
        <div>Grades: <span id="editGrades-${subjectId}"></span></div>
        <div>Sections: <span id="editSections-${subjectId}"></span></div>
      </div>
      <button class="btn small" onclick="saveSubjectEdit('${subjectId}')">Save</button>
      <button class="btn small secondary" onclick="document.getElementById('editSubjectPanel-${subjectId}').style.display='none'">Cancel</button>
    </div>`;
  panel.style.display = 'block';
  renderCheckGrid(`editGrades-${subjectId}`, `editSections-${subjectId}`, 'multi');
  currentClasses.forEach(c => {
    const gEl = document.querySelector(`.grid-editGrades-${subjectId}[value="${c.grade}"]`);
    const sEl = document.querySelector(`.grid-editSections-${subjectId}[value="${c.section}"]`);
    if (gEl) gEl.checked = true;
    if (sEl) sEl.checked = true;
  });
}

async function saveSubjectEdit(subjectId) {
  const name = document.getElementById(`editName-${subjectId}`).value.trim();
  const grades = getChecked(`editGrades-${subjectId}`);
  const sections = getChecked(`editSections-${subjectId}`);
  if (!name || !grades.length || !sections.length) { alert('Enter a name and check at least one grade and section'); return; }

  const classes = [];
  grades.forEach(g => sections.forEach(s => classes.push({ grade: g, section: s })));

  const { error } = await sb.rpc('update_subject', { p_subject_id: subjectId, p_name: name, p_classes: classes });
  if (error) { alert(error.message); return; }
  await loadSharedData();
}

async function deleteSubjectConfirm(subjectId) {
  const subject = subjects.find(s => s.id === subjectId);
  const sure = window.confirm(`Delete "${subject.name}"? This permanently deletes ALL its tests and marks, for every class and every year. This cannot be undone.`);
  if (!sure) return;
  const typed = window.prompt(`Type the subject name exactly to confirm deletion:`);
  if (typed !== subject.name) { alert('Name did not match — cancelled.'); return; }

  const { error } = await sb.rpc('delete_subject', { p_subject_id: subjectId });
  if (error) { alert(error.message); return; }
  await loadSharedData();
}

async function setCurrentYear(yearId) {
  await sb.from('academic_years').update({ is_current: false }).neq('id', yearId);
  const { error } = await sb.from('academic_years').update({ is_current: true }).eq('id', yearId);
  if (error) { alert(error.message); return; }
  await loadSharedData();
  await loadCurrentYear();
}

async function initializeYear() {
  const label = document.getElementById('newYearLabel').value.trim();
  if (!label) { alert('Enter a year label, e.g. 2026-27'); return; }
  if (!subjects.length) { alert('Add at least one subject first.'); return; }
  const { data, error } = await sb.rpc('initialize_academic_year', { p_label: label });
  if (error) { alert(error.message); return; }
  alert(`Done — ${data.testsCreated} PT test rows created (existing ones were left untouched).`);
  document.getElementById('newYearLabel').value = '';
  await loadSharedData();
}

// ── PT MAX MARKS TAB (super admin only) ─────────────────────────────────

async function loadPtMarks() {
  const year = document.getElementById('ptYear').value;
  const subject = document.getElementById('ptSubject').value;
  const grades = getChecked('ptGradeChecks');
  const sections = getChecked('ptSectionChecks');
  const listEl = document.getElementById('ptMarksList');
  if (!year || !subject) { listEl.innerHTML = '<p class="hint">Pick a year and subject.</p>'; return; }
  if (!grades.length || !sections.length) { listEl.innerHTML = '<p class="hint">Check at least one grade and one section.</p>'; return; }

  const { data, error } = await sb.from('tests').select('*')
    .eq('academic_year_id', year).eq('subject_id', subject).in('grade', grades).in('section', sections)
    .eq('is_predefined', true).order('grade').order('section').order('pt_number');
  if (error) { listEl.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }
  if (!data.length) { listEl.innerHTML = '<p class="hint">No PT tests found for this selection — initialize the academic year first (Setup tab), and make sure this subject is mapped to these classes.</p>'; return; }

  listEl.innerHTML = data.map(t => `
    <div class="test-row">
      <div>Grade ${t.grade}-${t.section} — ${t.name} ${t.is_locked ? '<span class="badge">Locked</span>' : ''}</div>
      <div style="display:flex; gap:8px; align-items:center;">
        <input type="number" id="pt-max-${t.id}" value="${t.max_marks ?? ''}" ${t.is_locked ? 'disabled' : ''} style="width:90px; padding:6px 8px; border:1px solid var(--paper-line); border-radius:3px;">
        <button class="btn small" onclick="savePtMax('${t.id}')" ${t.is_locked ? 'disabled' : ''}>Save</button>
        <button class="btn small secondary" onclick="toggleLock('${t.id}', ${!t.is_locked})">${t.is_locked ? 'Unlock' : 'Lock'}</button>
      </div>
    </div>`).join('');
}

async function savePtMax(testId) {
  const value = parseFloat(document.getElementById(`pt-max-${testId}`).value);
  if (isNaN(value)) { alert('Enter a number'); return; }
  const { error } = await sb.rpc('set_pt_max_marks', { p_test_id: testId, p_max_marks: value });
  if (error) { alert(error.message); return; }
  loadPtMarks();
}

async function toggleLock(testId, lock) {
  const { error } = await sb.rpc('set_test_lock', { p_test_id: testId, p_locked: lock });
  if (error) { alert(error.message); return; }
  loadPtMarks();
}

// ── TESTS & MARKS TAB ────────────────────────────────────────────────────

let adminCurrentTests = [], adminCurrentTest = null, adminCurrentStudents = [], adminEditingTestId = null;

function tmSectionsForGrade(grade) {
  return [...new Set(subjectClasses.filter(c => c.grade === grade).map(c => c.section))].sort();
}
function tmSubjectsForGradeSection(grade, section) {
  const ids = new Set(subjectClasses.filter(c => c.grade === grade && c.section === section).map(c => c.subject_id));
  return subjects.filter(s => ids.has(s.id));
}

function populateTmGrade() {
  document.getElementById('tmGrade').innerHTML = GRADE_LIST.map(g => `<option value="${g}">${g}</option>`).join('');
  populateTmSection();
}
function populateTmSection() {
  const grade = document.getElementById('tmGrade').value;
  const sections = tmSectionsForGrade(grade);
  document.getElementById('tmSection').innerHTML = sections.map(s => `<option value="${s}">${s}</option>`).join('');
  populateTmSubject();
}
function populateTmSubject() {
  const grade = document.getElementById('tmGrade').value;
  const section = document.getElementById('tmSection').value;
  const subs = tmSubjectsForGradeSection(grade, section);
  document.getElementById('tmSubject').innerHTML = subs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  adminEditingTestId = null;
  document.getElementById('adminMarksCard').style.display = 'none';
  loadAdminTests();
}

async function loadAdminTests() {
  const grade = document.getElementById('tmGrade').value;
  const section = document.getElementById('tmSection').value;
  const subject = document.getElementById('tmSubject').value;
  const listEl = document.getElementById('adminTestList');

  if (!grade || !section || !subject) { listEl.innerHTML = '<p class="hint">No subjects have been assigned to this class yet.</p>'; return; }
  if (!currentYearId) { listEl.innerHTML = '<p class="hint">No current academic year is set (Setup tab).</p>'; return; }

  const { data, error } = await sb.from('tests').select('*')
    .eq('academic_year_id', currentYearId).eq('subject_id', subject).eq('grade', grade).eq('section', section)
    .order('is_predefined', { ascending: false }).order('pt_number').order('name');
  if (error) { listEl.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }

  adminCurrentTests = data;
  if (!data.length) { listEl.innerHTML = '<div class="empty-state">No tests yet for this class.</div>'; return; }

  listEl.innerHTML = data.map(t => t.id === adminEditingTestId ? renderTestEditRow(t, 'saveAdminTestEdit', 'cancelAdminTestEdit') : renderTestRow(t, 'admin')).join('');
}

function renderTestRow(t, scope) {
  const editFn = scope === 'admin' ? 'startAdminEditTest' : 'startEditTest';
  const deleteFn = scope === 'admin' ? 'deleteAdminTest' : 'deleteTest';
  const enterFn = scope === 'admin' ? 'openAdminMarksEntry' : 'openMarksEntry';
  return `
    <div class="test-row">
      <div>${t.name}${t.is_predefined ? '<span class="badge">Predefined</span>' : ''}${t.is_locked ? '<span class="badge">Locked</span>' : ''}
        <div class="hint">Max marks: ${t.max_marks ?? '— not set'}</div>
      </div>
      <div style="display:flex; gap:6px;">
        ${!t.is_predefined ? `
          <button class="btn small secondary" onclick="${editFn}('${t.id}')">Edit</button>
          <button class="btn small secondary" onclick="${deleteFn}('${t.id}')">Delete</button>` : ''}
        <button class="btn small secondary" onclick="${enterFn}('${t.id}')" ${t.max_marks == null ? 'disabled' : ''}>Enter marks</button>
      </div>
    </div>`;
}

function renderTestEditRow(t, saveFn, cancelFn) {
  return `
    <div class="test-row" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div class="form-row">
        <input id="editTestName-${t.id}" value="${t.name}" placeholder="Test name">
        <input id="editTestMax-${t.id}" type="number" value="${t.max_marks ?? ''}" placeholder="Max marks">
      </div>
      <div style="display:flex; gap:6px;">
        <button class="btn small" onclick="${saveFn}('${t.id}')">Save</button>
        <button class="btn small secondary" onclick="${cancelFn}()">Cancel</button>
      </div>
    </div>`;
}

function startAdminEditTest(testId) { adminEditingTestId = testId; loadAdminTests(); }
function cancelAdminTestEdit() { adminEditingTestId = null; loadAdminTests(); }

async function saveAdminTestEdit(testId) {
  const name = document.getElementById(`editTestName-${testId}`).value.trim();
  const maxMarks = parseFloat(document.getElementById(`editTestMax-${testId}`).value);
  if (!name || isNaN(maxMarks)) { alert('Enter a name and max marks'); return; }
  const { error } = await sb.rpc('update_test', { p_test_id: testId, p_name: name, p_max_marks: maxMarks });
  if (error) { alert(error.message); return; }
  adminEditingTestId = null;
  loadAdminTests();
}

async function deleteAdminTest(testId) {
  const t = adminCurrentTests.find(x => x.id === testId);
  if (!window.confirm(`Delete test "${t.name}"? This permanently deletes all marks entered for it. This cannot be undone.`)) return;
  const { error } = await sb.rpc('delete_test', { p_test_id: testId });
  if (error) { alert(error.message); return; }
  loadAdminTests();
}

async function createAdminTest() {
  const name = document.getElementById('newTestName').value.trim();
  const maxMarks = parseFloat(document.getElementById('newTestMax').value);
  if (!name || !maxMarks) { alert('Enter a test name and max marks'); return; }

  const { error } = await sb.rpc('create_test', {
    p_name: name, p_subject_id: document.getElementById('tmSubject').value,
    p_grade: document.getElementById('tmGrade').value, p_section: document.getElementById('tmSection').value,
    p_academic_year_id: currentYearId, p_max_marks: maxMarks
  });
  if (error) { alert(error.message); return; }
  document.getElementById('newTestForm').style.display = 'none';
  document.getElementById('newTestName').value = '';
  document.getElementById('newTestMax').value = '';
  loadAdminTests();
}

async function openAdminMarksEntry(testId) {
  adminCurrentTest = adminCurrentTests.find(t => t.id === testId);
  const { data: students, error } = await sb.from('students').select('id, name')
    .eq('grade', adminCurrentTest.grade).eq('section', adminCurrentTest.section).eq('active', true).order('name');
  if (error) { alert(error.message); return; }
  adminCurrentStudents = students;

  const { data: marks } = await sb.from('marks').select('student_id, marks_obtained, is_absent').eq('test_id', testId);
  const marksByStudent = {};
  (marks || []).forEach(m => { marksByStudent[m.student_id] = m; });

  document.getElementById('adminMarksTitle').textContent = `${adminCurrentTest.name} — Grade ${adminCurrentTest.grade}-${adminCurrentTest.section} (max ${adminCurrentTest.max_marks})`;
  document.getElementById('adminMarksBanner').innerHTML = '';
  document.getElementById('adminMarksBody').innerHTML = students.map((s, i) => {
    const existing = marksByStudent[s.id];
    const absent = existing?.is_absent;
    return `
    <tr>
      <td class="roll-no mono">${i + 1}</td>
      <td>${s.name}</td>
      <td><input type="number" min="0" max="${adminCurrentTest.max_marks}" step="0.5" id="amarks-${s.id}" value="${absent ? '' : (existing?.marks_obtained ?? '')}" ${absent ? 'disabled' : ''}></td>
      <td><label style="font-size:0.8rem;"><input type="checkbox" id="aabsent-${s.id}" ${absent ? 'checked' : ''} onchange="document.getElementById('amarks-${s.id}').disabled=this.checked; if(this.checked) document.getElementById('amarks-${s.id}').value='';"> Absent</label></td>
    </tr>`;
  }).join('');
  document.getElementById('adminMarksCard').style.display = 'block';
  document.getElementById('adminMarksCard').scrollIntoView({ behavior: 'smooth' });
}

async function submitAdminMarks() {
  const records = {};
  for (const s of adminCurrentStudents) {
    const absent = document.getElementById(`aabsent-${s.id}`).checked;
    if (absent) { records[s.id] = 'ABSENT'; continue; }
    const val = document.getElementById(`amarks-${s.id}`).value;
    if (val !== '') records[s.id] = parseFloat(val);
  }
  const { data, error } = await sb.rpc('submit_marks', { p_test_id: adminCurrentTest.id, p_records: records });
  const banner = document.getElementById('adminMarksBanner');
  banner.innerHTML = error
    ? `<div class="status-banner warn">${error.message}</div>`
    : `<div class="status-banner ok">Saved marks for ${data.saved} students.</div>`;
}

// ── STUDENTS TAB ──────────────────────────────────────────────────────────

async function addStudent() {
  const student = {
    name: document.getElementById('stuName').value.trim(),
    gender: document.getElementById('stuGender').value || null,
    house_id: document.getElementById('stuHouse').value || null,
    grade: document.getElementById('stuGrade').value,
    section: document.getElementById('stuSection').value
  };
  if (!student.name) { alert('Enter a student name'); return; }
  const { error } = await sb.from('students').insert(student);
  if (error) { alert(error.message); return; }
  document.getElementById('stuName').value = '';
  alert('Student added.');
  loadStudents();
}

function parseCsvLine(line) {
  return line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
}

async function importCsv() {
  const fileInput = document.getElementById('csvFile');
  const status = document.getElementById('importStatus');
  if (!fileInput.files.length) { status.textContent = 'Choose a CSV file first.'; return; }

  const text = await fileInput.files[0].text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const houseByName = {};
  houses.forEach(h => { houseByName[h.name.toLowerCase()] = h.id; });

  let unmatchedHouses = 0;
  const rows = lines
    .map(parseCsvLine)
    .filter(c => c[0] && c[0].toLowerCase() !== 'name')
    .map(c => {
      const houseId = houseByName[(c[2] || '').toLowerCase()] || null;
      if (c[2] && !houseId) unmatchedHouses++;
      return { name: c[0], gender: c[1] || null, house_id: houseId, grade: c[3], section: c[4] };
    });

  if (!rows.length) { status.textContent = 'No valid rows found.'; return; }
  status.textContent = `Importing ${rows.length} students…`;
  const { error } = await sb.from('students').insert(rows);
  if (error) { status.textContent = error.message; return; }
  status.textContent = `Imported ${rows.length} students.` + (unmatchedHouses ? ` (${unmatchedHouses} had a house name that didn't match any existing house — added without a house.)` : '');
  fileInput.value = '';
  loadStudents();
}

async function loadStudents() {
  const grade = document.getElementById('filterGrade').value;
  const section = document.getElementById('filterSection').value;
  let query = sb.from('students').select('*, houses(name)').eq('active', true).order('grade').order('section').order('name');
  if (grade) query = query.eq('grade', grade);
  if (section) query = query.eq('section', section);
  const { data, error } = await query;
  const listEl = document.getElementById('studentsList');
  if (error) { listEl.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }

  const extraCols = fieldDefs.map(f => `<th>${f.label}</th>`).join('');
  listEl.innerHTML = `
    <table class="roll">
      <thead><tr><th>Name</th><th>Gender</th><th>House</th><th>Class</th>${extraCols}<th></th></tr></thead>
      <tbody>
        ${data.map(s => `
          <tr>
            <td>${s.name}</td>
            <td>${s.gender || '—'}</td>
            <td>${s.houses ? s.houses.name : '—'}</td>
            <td>${s.grade}-${s.section}</td>
            ${fieldDefs.map(f => `<td>${(s.extra_fields || {})[f.field_key] ?? '—'}</td>`).join('')}
            <td>
              <button class="btn small secondary" onclick="editStudent('${s.id}')">Edit</button>
              ${fieldDefs.length ? `<button class="btn small secondary" onclick="editStudentFields('${s.id}')">Fields</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>` || '<p class="hint">No students found.</p>';
}

async function editStudent(studentId) {
  const name = window.prompt('Name:');
  const updates = {};
  if (name) updates.name = name;
  const grade = window.prompt('Grade (leave blank to skip):');
  if (grade) updates.grade = grade;
  const section = window.prompt('Section (leave blank to skip):');
  if (section) updates.section = section;
  if (!Object.keys(updates).length) return;
  const { error } = await sb.from('students').update(updates).eq('id', studentId);
  if (error) { alert(error.message); return; }
  loadStudents();
}

async function editStudentFields(studentId) {
  const { data: student } = await sb.from('students').select('extra_fields').eq('id', studentId).single();
  const extra = { ...(student?.extra_fields || {}) };
  for (const f of fieldDefs) {
    const current = extra[f.field_key] ?? '';
    const val = window.prompt(`${f.label}${f.field_type === 'select' ? ' (' + (f.options || []).join(', ') + ')' : ''}:`, current);
    if (val !== null) extra[f.field_key] = val;
  }
  const { error } = await sb.from('students').update({ extra_fields: extra }).eq('id', studentId);
  if (error) { alert(error.message); return; }
  loadStudents();
}

// ── TEACHERS TAB (super admin only) ──────────────────────────────────────

function addAssignmentToBuilder() {
  const subjectId = document.getElementById('assignSubject').value;
  const subjectName = subjects.find(s => s.id === subjectId)?.name || '';
  const grade = document.getElementById('assignGrade').value;
  const section = document.getElementById('assignSection').value;
  pendingAssignments.push({ subjectId, subjectName, grade, section });
  renderAssignmentsPreview();
}

function removeAssignmentFromBuilder(idx) {
  pendingAssignments.splice(idx, 1);
  renderAssignmentsPreview();
}

function renderAssignmentsPreview() {
  document.getElementById('assignmentsPreview').innerHTML = pendingAssignments.map((a, i) =>
    `${a.subjectName} — Grade ${a.grade}-${a.section} <button class="link" onclick="removeAssignmentFromBuilder(${i})">remove</button>`
  ).join('<br>');
}

async function createTeacher() {
  const payload = {
    name: document.getElementById('teachName').value.trim(),
    username: document.getElementById('teachUsername').value.trim(),
    password: document.getElementById('teachPassword').value,
    role: document.getElementById('teachRole').value,
    assignments: pendingAssignments.map(a => ({ subjectId: a.subjectId, grade: a.grade, section: a.section }))
  };
  if (!payload.name || !payload.username || !payload.password) { alert('Enter name, username, and password'); return; }
  const res = await Auth.callAdminAction('createTeacher', payload);
  if (!res.ok) { alert(res.error); return; }
  document.getElementById('teachName').value = '';
  document.getElementById('teachUsername').value = '';
  document.getElementById('teachPassword').value = '';
  pendingAssignments = [];
  renderAssignmentsPreview();
  loadTeachers();
}

async function resetTeacherPassword(username) {
  const newPassword = window.prompt(`New password for "${username}" (6+ characters):`);
  if (!newPassword) return;
  const res = await Auth.callAdminAction('resetPassword', { username, newPassword });
  if (!res.ok) { alert(res.error); return; }
  alert(`Password reset for ${username}.`);
}

async function loadTeachers() {
  const el = document.getElementById('teacherList');
  const { data: profiles, error } = await sb.from('profiles').select('*').order('role').order('name');
  if (error) { el.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }

  const { data: assignData } = await sb.from('teacher_assignments').select('teacher_id, grade, section, subjects(name)');
  const assignByTeacher = {};
  (assignData || []).forEach(a => {
    (assignByTeacher[a.teacher_id] ??= []).push(`${a.subjects.name} ${a.grade}-${a.section}`);
  });

  el.innerHTML = `
    <table class="roll">
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Classes</th><th></th></tr></thead>
      <tbody>
        ${profiles.map(p => `
          <tr>
            <td>${p.name}</td>
            <td class="mono">${p.username}</td>
            <td>${p.role}</td>
            <td>${(assignByTeacher[p.id] || []).join(', ') || '—'}</td>
            <td><button class="btn small secondary" onclick="resetTeacherPassword('${p.username}')">Reset password</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── REPORTS TAB ──────────────────────────────────────────────────────────

let reportTestOptions = [];

async function loadReportTestOptions() {
  const year = document.getElementById('repYear').value;
  const subject = document.getElementById('repSubject').value;
  const grade = document.getElementById('repGrade').value;
  const section = document.getElementById('repSection').value;
  let query = sb.from('tests').select('*, subjects(name)').eq('academic_year_id', year)
    .order('grade').order('section').order('is_predefined', { ascending: false }).order('pt_number').order('name');
  if (subject) query = query.eq('subject_id', subject);
  if (grade) query = query.eq('grade', grade);
  if (section) query = query.eq('section', section);
  const { data, error } = await query;
  const el = document.getElementById('testChecklist');
  if (error) { el.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }

  reportTestOptions = data;
  el.innerHTML = data.map(t => `
    <label><input type="checkbox" value="${t.id}" class="testCheckbox"> ${t.subjects.name} — Grade ${t.grade}-${t.section} — ${t.name}</label>
  `).join('') || '<p class="hint">No tests found for this selection.</p>';
}

function selectedTestIds() {
  return Array.from(document.querySelectorAll('.testCheckbox:checked')).map(cb => cb.value);
}

document.addEventListener('change', (e) => {
  if (e.target.id === 'reportType') {
    document.getElementById('leaderboardFilters').style.display = ['leaderboard', 'top3'].includes(e.target.value) ? 'flex' : 'none';
    document.getElementById('classSheetFilters').style.display = e.target.value === 'classSheet' ? 'flex' : 'none';
  }
});

async function generateReport() {
  const testIds = selectedTestIds();
  if (!testIds.length) { alert('Select at least one test.'); return; }
  const type = document.getElementById('reportType').value;
  const printArea = document.getElementById('printArea');

  if (type === 'leaderboard') {
    const { data, error } = await sb.rpc('get_leaderboard', {
      p_test_ids: testIds,
      p_grade: document.getElementById('lbGrade').value || null,
      p_section: document.getElementById('lbSection').value || null,
      p_house_id: document.getElementById('lbHouse').value || null,
      p_limit: document.getElementById('lbLimit').value ? parseInt(document.getElementById('lbLimit').value) : null
    });
    if (error) { printArea.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }
    printArea.innerHTML = `<h3>Leaderboard</h3><table><thead><tr><th>#</th><th>Name</th><th>Class</th><th>House</th><th>Marks</th><th>%</th></tr></thead><tbody>
      ${data.map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.grade}-${r.section}</td><td>${r.house_name || '—'}</td><td>${r.total_obtained}/${r.total_max}</td><td>${r.percentage}</td></tr>`).join('')}
    </tbody></table>`;

  } else if (type === 'top3') {
    const { data, error } = await sb.rpc('get_top_n_per_class', { p_test_ids: testIds, p_top_n: 3 });
    if (error) { printArea.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }
    printArea.innerHTML = `<h3>Top 3 per class</h3><table><thead><tr><th>Class</th><th>Rank</th><th>Name</th><th>Marks</th><th>%</th></tr></thead><tbody>
      ${data.map(r => `<tr><td>${r.grade}-${r.section}</td><td>${r.rank}</td><td>${r.name}</td><td>${r.total_obtained}/${r.total_max}</td><td>${r.percentage}</td></tr>`).join('')}
    </tbody></table>`;

  } else if (type === 'classSheet') {
    const grade = document.getElementById('csGrade').value;
    const section = document.getElementById('csSection').value;
    const { data, error } = await sb.rpc('get_class_result_sheet', { p_test_ids: testIds, p_grade: grade, p_section: section });
    if (error) { printArea.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }

    const testNames = [...new Set(data.map(r => r.test_name + ' (' + r.subject_name + ')'))];
    const byStudent = {};
    data.forEach(r => {
      const label = r.test_name + ' (' + r.subject_name + ')';
      (byStudent[r.student_name] ??= {})[label] = r.is_absent ? 'AB' : (r.marks_obtained ?? '—');
    });
    printArea.innerHTML = `<h3>Class Result Sheet — Grade ${grade}-${section}</h3><table><thead><tr><th>Student</th>${testNames.map(n => `<th>${n}</th>`).join('')}</tr></thead><tbody>
      ${Object.keys(byStudent).map(name => `<tr><td>${name}</td>${testNames.map(n => `<td>${byStudent[name][n] ?? '—'}</td>`).join('')}</tr>`).join('')}
    </tbody></table>`;
  }
}

function exportPdf() {
  const el = document.getElementById('printArea');
  if (!el.innerHTML.trim()) { alert('Generate a report first.'); return; }
  html2pdf().from(el).set({ margin: 10, filename: 'report.pdf' }).save();
}

// ── FIELDS TAB (super admin only) ────────────────────────────────────────

async function addField() {
  const key = document.getElementById('fieldKey').value.trim();
  const label = document.getElementById('fieldLabel').value.trim();
  const type = document.getElementById('fieldType').value;
  const optionsRaw = document.getElementById('fieldOptions').value.trim();
  const options = type === 'select' && optionsRaw ? optionsRaw.split(',').map(o => o.trim()) : null;
  if (!key || !label) { alert('Enter a field key and label'); return; }

  const { error } = await sb.rpc('add_field_definition', { p_field_key: key, p_label: label, p_field_type: type, p_options: options });
  if (error) { alert(error.message); return; }
  document.getElementById('fieldKey').value = '';
  document.getElementById('fieldLabel').value = '';
  document.getElementById('fieldOptions').value = '';
  await loadSharedData();
  loadFields();
}

function loadFields() {
  document.getElementById('fieldsList').innerHTML = fieldDefs.map(f => `
    <div class="test-row"><div>${f.label} <span class="hint">(${f.field_type})</span></div></div>
  `).join('') || '<p class="hint">No custom fields yet.</p>';
}

// ── INIT ────────────────────────────────────────────────────────────────

window.onload = async () => {
  const auth = await Auth.requireOrRedirect();
  if (!auth) return;
  profile = auth.profile;
  if (profile.role === 'teacher') { window.location.href = 'teacher.html'; return; }

  document.getElementById('whoLabel').textContent = `${profile.name} (${profile.role})`;

  const isSuperAdmin = profile.role === 'super_admin';
  if (isSuperAdmin) {
    document.getElementById('fieldsTabBtn').style.display = 'inline-block';
    document.getElementById('adminRoleOption').style.display = 'block';
  } else {
    // Setup, PT Max Marks, and Teachers are super_admin-only now.
    document.getElementById('setupTabBtn').style.display = 'none';
    document.getElementById('ptmarksTabBtn').style.display = 'none';
    document.getElementById('teachersTabBtn').style.display = 'none';
  }

  renderCheckGrid('ptGradeChecks', 'ptSectionChecks', 'multi');

  await loadSharedData();
  await loadCurrentYear();

  populateTmGrade();
  document.getElementById('tmGrade').addEventListener('change', populateTmSection);
  document.getElementById('tmSection').addEventListener('change', populateTmSubject);
  document.getElementById('tmSubject').addEventListener('change', () => { adminEditingTestId = null; document.getElementById('adminMarksCard').style.display = 'none'; loadAdminTests(); });

  showTab(isSuperAdmin ? 'setup' : 'testsmarks');
};

async function loadCurrentYear() {
  const { data, error } = await sb.from('academic_years').select('id, label').eq('is_current', true).maybeSingle();
  currentYearId = (!error && data) ? data.id : null;
}
