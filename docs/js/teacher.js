let profile, assignments = [], currentYearId = null, currentTests = [], currentTest = null, currentStudents = [];

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

  listEl.innerHTML = data.map(t => `
    <div class="test-row">
      <div>${t.name}${t.is_predefined ? '<span class="badge">Predefined</span>' : ''}${t.is_locked ? '<span class="badge">Locked</span>' : ''}
        <div class="hint">Max marks: ${t.max_marks ?? '— not set yet'}</div>
      </div>
      <button class="btn small secondary" onclick="openMarksEntry('${t.id}')" ${t.max_marks == null ? 'disabled title="Max marks not set yet"' : ''}>Enter marks</button>
    </div>`).join('');
}

function backToTests() {
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
  const marksByStudent = {};
  (marks || []).forEach(m => { marksByStudent[m.student_id] = m; });

  document.getElementById('marksTitle').textContent = `${currentTest.name} — Grade ${a.grade}-${a.section}`;
  document.getElementById('maxMarksHint').textContent = `Max marks: ${currentTest.max_marks}`;
  document.getElementById('marksBanner').innerHTML = '';

  const body = document.getElementById('marksBody');
  body.innerHTML = students.map((s, i) => {
    const existing = marksByStudent[s.id];
    const absent = existing?.is_absent;
    return `
    <tr>
      <td class="roll-no mono">${i + 1}</td>
      <td>${s.name}</td>
      <td><input type="number" min="0" max="${currentTest.max_marks}" step="0.5" id="marks-${s.id}" value="${absent ? '' : (existing?.marks_obtained ?? '')}" ${absent ? 'disabled' : ''}></td>
      <td><input type="checkbox" id="absent-${s.id}" ${absent ? 'checked' : ''} onchange="document.getElementById('marks-${s.id}').disabled=this.checked; if(this.checked) document.getElementById('marks-${s.id}').value='';"></td>
    </tr>`;
  }).join('');

  // This is the "show only pickers + students" step — hide the tests list
  // while marks entry is open.
  document.getElementById('testsCard').style.display = 'none';
  document.getElementById('marksCard').style.display = 'block';
  document.getElementById('marksCard').scrollIntoView({ behavior: 'smooth' });
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
