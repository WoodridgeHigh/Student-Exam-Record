let profile, assignments = [], years = [], currentTests = [], currentTest = null, currentStudents = [];

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

function selectedAssignment() {
  const idx = document.getElementById('assignmentPicker').value;
  return assignments[idx];
}

function selectedYearId() {
  return document.getElementById('yearPicker').value;
}

async function loadAssignmentsAndYears() {
  const { data: assignData, error: assignErr } = await sb
    .from('teacher_assignments')
    .select('id, subject_id, grade, section, subjects(name)')
    .eq('teacher_id', profile.id);
  if (assignErr) { alert(assignErr.message); return; }
  assignments = assignData;

  const picker = document.getElementById('assignmentPicker');
  if (!assignments.length) {
    picker.innerHTML = '<option>No classes assigned yet — contact admin</option>';
    return;
  }
  picker.innerHTML = assignments.map((a, i) => `<option value="${i}">${a.subjects.name} — Grade ${a.grade}-${a.section}</option>`).join('');

  const { data: yearData } = await sb.from('academic_years').select('*').order('label', { ascending: false });
  years = yearData || [];
  const yearPicker = document.getElementById('yearPicker');
  yearPicker.innerHTML = years.map(y => `<option value="${y.id}" ${y.is_current ? 'selected' : ''}>${y.label}</option>`).join('');

  picker.addEventListener('change', loadTests);
  yearPicker.addEventListener('change', loadTests);
  loadTests();
}

function showNewTestForm() {
  document.getElementById('newTestForm').style.display = 'block';
}

async function createTest() {
  const a = selectedAssignment();
  const name = document.getElementById('newTestName').value.trim();
  const maxMarks = parseFloat(document.getElementById('newTestMax').value);
  if (!name || !maxMarks) { alert('Enter a test name and max marks'); return; }

  const { data, error } = await sb.rpc('create_test', {
    p_name: name, p_subject_id: a.subject_id, p_grade: a.grade, p_section: a.section,
    p_academic_year_id: selectedYearId(), p_max_marks: maxMarks
  });
  if (error) { alert(error.message); return; }
  document.getElementById('newTestForm').style.display = 'none';
  document.getElementById('newTestName').value = '';
  document.getElementById('newTestMax').value = '';
  loadTests();
}

async function loadTests() {
  const a = selectedAssignment();
  if (!a) return;
  document.getElementById('marksCard').style.display = 'none';

  const { data, error } = await sb.from('tests').select('*')
    .eq('subject_id', a.subject_id).eq('grade', a.grade).eq('section', a.section).eq('academic_year_id', selectedYearId())
    .order('is_predefined', { ascending: false }).order('pt_number').order('name');
  if (error) { document.getElementById('testList').innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }

  currentTests = data;
  const listEl = document.getElementById('testList');
  if (!data.length) { listEl.innerHTML = '<div class="empty-state">No tests yet for this class/year.</div>'; return; }

  listEl.innerHTML = data.map(t => `
    <div class="test-row">
      <div>${t.name}${t.is_predefined ? '<span class="badge">Predefined</span>' : ''}${t.is_locked ? '<span class="badge">Locked</span>' : ''}
        <div class="hint">Max marks: ${t.max_marks ?? '— not set yet'}</div>
      </div>
      <button class="btn small secondary" onclick="openMarksEntry('${t.id}')" ${t.max_marks == null ? 'disabled title="Max marks not set yet"' : ''}>Enter marks</button>
    </div>`).join('');
}

async function openMarksEntry(testId) {
  currentTest = currentTests.find(t => t.id === testId);
  const a = selectedAssignment();

  const { data: students, error: studErr } = await sb.from('students').select('id, name')
    .eq('grade', a.grade).eq('section', a.section).eq('active', true).order('name');
  if (studErr) { alert(studErr.message); return; }
  currentStudents = students;

  const { data: marks } = await sb.from('marks').select('student_id, marks_obtained').eq('test_id', testId);
  const marksByStudent = {};
  (marks || []).forEach(m => { marksByStudent[m.student_id] = m.marks_obtained; });

  document.getElementById('marksTitle').textContent = `${currentTest.name} — Grade ${a.grade}-${a.section}`;
  document.getElementById('maxMarksHint').textContent = `Max marks: ${currentTest.max_marks}`;
  document.getElementById('marksBanner').innerHTML = '';

  const body = document.getElementById('marksBody');
  body.innerHTML = students.map((s, i) => `
    <tr>
      <td class="roll-no mono">${i + 1}</td>
      <td>${s.name}</td>
      <td><input type="number" min="0" max="${currentTest.max_marks}" step="0.5" id="marks-${s.id}" value="${marksByStudent[s.id] ?? ''}"></td>
    </tr>`).join('');

  document.getElementById('marksCard').style.display = 'block';
  document.getElementById('marksCard').scrollIntoView({ behavior: 'smooth' });
}

async function submitMarks() {
  const records = {};
  for (const s of currentStudents) {
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
  loadAssignmentsAndYears();
};
