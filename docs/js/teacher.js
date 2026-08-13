let profile, assignments = [], currentYearId = null, currentTests = [], currentTest = null, currentStudents = [], currentMarksByStudent = {};

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

// ── CASCADING GRADE → SECTION → SUBJECT PICKERS ─────────────────────────
// Only combinations the teacher is actually assigned to are selectable.

function distinctGrades() {
  return [...new Set(assignments.map(a => a.grade))].sort();
}
function sectionsForGrade(grade) {
  return [...new Set(assignments.filter(a => a.grade === grade).map(a => a.section))].sort();
}
function subjectsForGradeSection(grade, section) {
  return assignments.filter(a => a.grade === grade && a.section === section);
}

function currentAssignment() {
  const subjectId = document.getElementById('subjectPicker').value;
  const grade = document.getElementById('gradePicker').value;
  const section = document.getElementById('sectionPicker').value;
  return assignments.find(a => a.grade === grade && a.section === section && a.subject_id === subjectId);
}

function populateGradePicker() {
  const grades = distinctGrades();
  document.getElementById('gradePicker').innerHTML = grades.map(g => `<option value="${g}">${g}</option>`).join('');
  populateSectionPicker();
}

function populateSectionPicker() {
  const grade = document.getElementById('gradePicker').value;
  const sections = sectionsForGrade(grade);
  document.getElementById('sectionPicker').innerHTML = sections.map(s => `<option value="${s}">${s}</option>`).join('');
  populateSubjectPicker();
}

function populateSubjectPicker() {
  const grade = document.getElementById('gradePicker').value;
  const section = document.getElementById('sectionPicker').value;
  const subs = subjectsForGradeSection(grade, section);
  document.getElementById('subjectPicker').innerHTML = subs.map(a => `<option value="${a.subject_id}">${a.subjects.name}</option>`).join('');
  backToTests();
  loadTests();
}

async function loadAssignmentsAndYear() {
  const { data: assignData, error: assignErr } = await sb
    .from('teacher_assignments')
    .select('id, subject_id, grade, section, subjects(name)')
    .eq('teacher_id', profile.id);
  if (assignErr) { alert(assignErr.message); return; }
  assignments = assignData;

  if (!assignments.length) {
    document.getElementById('testList').innerHTML = '<div class="empty-state">No classes assigned yet — contact admin.</div>';
    return;
  }

  const { data: yearData, error: yearErr } = await sb.from('academic_years').select('id, label').eq('is_current', true).maybeSingle();
  if (yearErr || !yearData) {
    document.getElementById('testList').innerHTML = '<div class="status-banner warn">No current academic year is set. Ask the admin to mark one as current.</div>';
    return;
  }
  currentYearId = yearData.id;

  populateGradePicker();
  document.getElementById('gradePicker').addEventListener('change', populateSectionPicker);
  document.getElementById('sectionPicker').addEventListener('change', populateSubjectPicker);
  document.getElementById('subjectPicker').addEventListener('change', () => { backToTests(); loadTests(); });
}

function showNewTestForm() {
  document.getElementById('newTestForm').style.display = 'block';
}

async function createTest() {
  const a = currentAssignment();
  const name = document.getElementById('newTestName').value.trim();
  const maxMarks = parseFloat(document.getElementById('newTestMax').value);
  if (!name || !maxMarks) { alert('Enter a test name and max marks'); return; }

  const { error } = await sb.rpc('create_test', {
    p_name: name, p_subject_id: a.subject_id, p_grade: a.grade, p_section: a.section,
    p_academic_year_id: currentYearId, p_max_marks: maxMarks
  });
  if (error) { alert(error.message); return; }
  document.getElementById('newTestForm').style.display = 'none';
  document.getElementById('newTestName').value = '';
  document.getElementById('newTestMax').value = '';
  loadTests();
}

let editingTestId = null;

async function loadTests() {
  const a = currentAssignment();
  if (!a || !currentYearId) return;

  const { data, error } = await sb.from('tests').select('*')
    .eq('subject_id', a.subject_id).eq('grade', a.grade).eq('section', a.section).eq('academic_year_id', currentYearId)
    .order('is_predefined', { ascending: false }).order('pt_number').order('name');
  if (error) { document.getElementById('testList').innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }

  currentTests = data;
  const listEl = document.getElementById('testList');
  if (!data.length) { listEl.innerHTML = '<div class="empty-state">No tests yet for this class/subject.</div>'; return; }

  listEl.innerHTML = data.map(t => t.id === editingTestId ? renderTestEditRow(t) : renderTestRow(t)).join('');
}

function renderTestRow(t) {
  return `
    <div class="test-row">
      <div>${t.name}${t.is_predefined ? '<span class="badge">Predefined</span>' : ''}${t.is_locked ? '<span class="badge">Locked</span>' : ''}
        <div class="hint">Max marks: ${t.max_marks ?? '— not set yet'}</div>
      </div>
      <div style="display:flex; gap:6px;">
        ${!t.is_predefined ? `
          <button class="btn small secondary" onclick="startEditTest('${t.id}')">Edit</button>
          <button class="btn small secondary" onclick="deleteTest('${t.id}')">Delete</button>` : ''}
        <button class="btn small secondary" onclick="openMarksEntry('${t.id}')" ${t.max_marks == null ? 'disabled title="Max marks not set yet"' : ''}>Enter marks</button>
      </div>
    </div>`;
}

function renderTestEditRow(t) {
  return `
    <div class="test-row" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div class="form-row">
        <input id="editTestName-${t.id}" value="${t.name}" placeholder="Test name">
        <input id="editTestMax-${t.id}" type="number" value="${t.max_marks ?? ''}" placeholder="Max marks">
      </div>
      <div style="display:flex; gap:6px;">
        <button class="btn small" onclick="saveTestEdit('${t.id}')">Save</button>
        <button class="btn small secondary" onclick="cancelTestEdit()">Cancel</button>
      </div>
    </div>`;
}

function startEditTest(testId) { editingTestId = testId; loadTests(); }
function cancelTestEdit() { editingTestId = null; loadTests(); }

async function saveTestEdit(testId) {
  const name = document.getElementById(`editTestName-${testId}`).value.trim();
  const maxMarks = parseFloat(document.getElementById(`editTestMax-${testId}`).value);
  if (!name || isNaN(maxMarks)) { alert('Enter a name and max marks'); return; }
  const { error } = await sb.rpc('update_test', { p_test_id: testId, p_name: name, p_max_marks: maxMarks });
  if (error) { alert(error.message); return; }
  editingTestId = null;
  loadTests();
}

async function deleteTest(testId) {
  const t = currentTests.find(x => x.id === testId);
  if (!window.confirm(`Delete test "${t.name}"? This permanently deletes all marks entered for it. This cannot be undone.`)) return;
  const { error } = await sb.rpc('delete_test', { p_test_id: testId });
  if (error) { alert(error.message); return; }
  loadTests();
}

function backToTests() {
  editingTestId = null;
  document.getElementById('marksCard').style.display = 'none';
  document.getElementById('testsCard').style.display = 'block';
}

async function openMarksEntry(testId) {
  currentTest = currentTests.find(t => t.id === testId);
  const a = currentAssignment();

  const { data: students, error: studErr } = await sb.from('students').select('id, name')
    .eq('grade', a.grade).eq('section', a.section).eq('active', true).order('name');
  if (studErr) { alert(studErr.message); return; }
  currentStudents = students;

  const { data: marks } = await sb.from('marks').select('student_id, marks_obtained, is_absent').eq('test_id', testId);
  currentMarksByStudent = {};
  (marks || []).forEach(m => { currentMarksByStudent[m.student_id] = m; });

  document.getElementById('marksTitle').textContent = `${currentTest.name} — Grade ${a.grade}-${a.section}`;
  document.getElementById('maxMarksHint').textContent = `Max marks: ${currentTest.max_marks}`;
  document.getElementById('marksBanner').innerHTML = '';

  renderMarksBody();

  // This is the "show only pickers + students" step — hide the tests list
  // while marks entry is open.
  document.getElementById('testsCard').style.display = 'none';
  document.getElementById('marksCard').style.display = 'block';
  document.getElementById('marksCard').scrollIntoView({ behavior: 'smooth' });
}

function renderMarksBody() {
  const body = document.getElementById('marksBody');
  body.innerHTML = currentStudents.map((s, i) => {
    const existing = currentMarksByStudent[s.id];
    const absent = existing?.is_absent;
    return `
    <tr>
      <td class="roll-no mono">${i + 1}</td>
      <td>${s.name}</td>
      <td><input type="number" min="0" max="${currentTest.max_marks}" step="0.5" id="marks-${s.id}" value="${absent ? '' : (existing?.marks_obtained ?? '')}" ${absent ? 'disabled' : ''}></td>
      <td><input type="checkbox" id="absent-${s.id}" ${absent ? 'checked' : ''} onchange="document.getElementById('marks-${s.id}').disabled=this.checked; if(this.checked){ document.getElementById('marks-${s.id}').value=''; document.getElementById('marks-${s.id}').classList.remove('invalid'); }"></td>
    </tr>`;
  }).join('');
  wireMarksTableUX(currentStudents, currentTest.max_marks, 'marks', 'absent', 'marksProgress');
}

function downloadTemplate() {
  downloadMarksTemplate(currentTest, currentStudents, currentMarksByStudent);
}

async function uploadMarksFile() {
  const fileInput = document.getElementById('uploadMarksFile');
  if (!fileInput.files.length) { alert('Choose a file first.'); return; }
  let parsed;
  try {
    parsed = await parseMarksFile(fileInput.files[0]);
  } catch (err) {
    alert('Could not read that file: ' + err.message);
    return;
  }

  let matched = 0;
  currentStudents.forEach(s => {
    const rec = parsed[s.id];
    if (!rec) return;
    matched++;
    const markInput = document.getElementById(`marks-${s.id}`);
    const absentInput = document.getElementById(`absent-${s.id}`);
    if (rec.absent) {
      absentInput.checked = true;
      markInput.value = '';
      markInput.disabled = true;
      markInput.classList.remove('invalid');
    } else {
      absentInput.checked = false;
      markInput.disabled = false;
      markInput.value = rec.marks ?? '';
      markInput.classList.toggle('invalid', rec.marks != null && currentTest.max_marks != null && rec.marks > currentTest.max_marks);
    }
  });
  fileInput.value = '';
  wireMarksTableUX(currentStudents, currentTest.max_marks, 'marks', 'absent', 'marksProgress');
  alert(`Loaded marks for ${matched} of ${currentStudents.length} students from the file. Review below, then click "Save marks".`);
}

async function submitMarks() {
  const records = {};
  for (const s of currentStudents) {
    const absent = document.getElementById(`absent-${s.id}`).checked;
    if (absent) { records[s.id] = 'ABSENT'; continue; }
    const val = document.getElementById(`marks-${s.id}`).value;
    if (val !== '') records[s.id] = parseFloat(val);
  }
  const { data, error } = await sb.rpc('submit_marks', { p_test_id: currentTest.id, p_records: records });
  const banner = document.getElementById('marksBanner');
  if (error) {
    banner.innerHTML = `<div class="status-banner warn">${error.message}</div>`;
  } else {
    banner.innerHTML = `<div class="status-banner ok">Saved marks for ${data.saved} students.</div>`;
  }
}

window.onload = async () => {
  const auth = await Auth.requireOrRedirect();
  if (!auth) return;
  profile = auth.profile;
  if (profile.role !== 'teacher') { window.location.href = 'admin.html'; return; }

  document.getElementById('whoLabel').textContent = `${profile.name} (${profile.username})`;
  loadAssignmentsAndYear();
};
