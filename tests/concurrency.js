// tests/concurrency.js
// Challenge 1: two clients ask for the last place in a group at the same moment.
// Exactly one request may succeed; the other must receive GROUP_FULL.
//
// Run from the project root with the server already running:
//   node tests/concurrency.js            (runs, prints results, cleans up)
//   node tests/concurrency.js --keep     (leaves the final fixture in MySQL so you can query it)
//
// Needs Node 18 or newer (built-in fetch). It only touches the temporary group
// "CT-G01" and students whose number starts with 9000000.

require('dotenv').config();
const crypto = require('crypto');
const { pool } = require('../db');

const BASE = process.env.API_BASE || 'http://localhost:3000';
const LECTURER = { email: 'teacher@school.com', password: 'password123' };
const GROUP_NAME = 'CT-G01';
const ROUNDS = 20;
const PREFIX = '9000000';            // test student numbers 900000000 .. 900000015
const KEEP = process.argv.includes('--keep');

// Every way a student can be put into a group, paired against each other
const PAIRS = [
  ['assign', 'assign'],
  ['sync', 'sync'],
  ['approve', 'approve'],
  ['assign', 'sync'],
  ['assign', 'approve'],
  ['sync', 'approve'],
];

const opIds = [];

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 or empty body */ }
  return { status: res.status, json };
}

// Turn the three different response shapes into one word
function outcome(kind, r) {
  if (kind === 'sync') {
    const x = r.json && r.json.results && r.json.results[0];
    if (!x) return `ERROR(${r.status})`;
    return x.status === 'applied' ? 'OK' : (x.code || x.status);
  }
  if (r.status === 200) return 'OK';
  return (r.json && r.json.error) || `ERROR(${r.status})`;
}

async function teardown() {
  await pool.query(
    'DELETE FROM group_change_requests WHERE student_id IN (SELECT student_id FROM studentREG WHERE student_no LIKE ?)',
    [PREFIX + '%']);
  await pool.query('DELETE FROM studentREG WHERE student_no LIKE ?', [PREFIX + '%']);
  await pool.query('DELETE FROM student_groups WHERE group_name = ?', [GROUP_NAME]);
}

async function setup() {
  await pool.query('INSERT INTO student_groups (group_name, capacity) VALUES (?, 15)', [GROUP_NAME]);
  const [[g]] = await pool.query('SELECT group_id FROM student_groups WHERE group_name = ?', [GROUP_NAME]);
  const ids = [];
  for (let i = 0; i < 16; i++) {
    const [r] = await pool.query(
      `INSERT INTO studentREG (student_no, student_name, student_email, student_pw, program, updated_at)
       VALUES (?, ?, ?, 'not-a-real-hash', 'CS', ?)`,
      [PREFIX + String(i).padStart(2, '0'), `Concurrency Test ${i}`, `ct${i}@test.local`, new Date()]);
    ids.push(r.insertId);
  }
  return { groupId: g.group_id, ids };
}

// Reset fixture: G01-style group with exactly 14 members, 2 students waiting
async function reset(fx) {
  await pool.query('DELETE FROM group_change_requests WHERE student_id IN (?)', [fx.ids]);
  await pool.query(
    'UPDATE studentREG SET student_group = NULL, deleted = 0, deleted_at = NULL, deleted_by = NULL, version = 1 WHERE student_id IN (?)',
    [fx.ids]);
  await pool.query('UPDATE studentREG SET student_group = ? WHERE student_id IN (?)', [fx.groupId, fx.ids.slice(0, 14)]);
}

// Returns a function that sends one client's request when called
async function prepare(kind, studentId, fx, token) {
  if (kind === 'assign')
    return () => api('POST', `/api/groups/${fx.groupId}/assign`, token, { studentIds: [studentId] });

  if (kind === 'sync') {
    const opId = crypto.randomUUID();
    opIds.push(opId);
    return () => api('POST', '/api/sync', token, {
      operations: [{ opId, type: 'update', studentId, baseVersion: 1, payload: { groupId: fx.groupId } }],
    });
  }

  // approve: a pending group-change request already exists for this student
  const [r] = await pool.query(
    'INSERT INTO group_change_requests (student_id, requested_group, created_at) VALUES (?, ?, ?)',
    [studentId, fx.groupId, new Date()]);
  return () => api('POST', `/api/requests/group-change/${r.insertId}/approve`, token);
}

async function round(fx, token, kinds) {
  await reset(fx);
  const candidates = [fx.ids[14], fx.ids[15]];
  const calls = [];
  for (let i = 0; i < 2; i++) calls.push(await prepare(kinds[i], candidates[i], fx, token));

  // Both requests leave at the same moment
  const results = await Promise.all(calls.map((send, i) => send().then((r) => outcome(kinds[i], r))));

  const [[{ cnt }]] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM studentREG WHERE student_group = ? AND deleted = 0', [fx.groupId]);
  const ok = results.filter((x) => x === 'OK').length;
  const full = results.filter((x) => x === 'GROUP_FULL').length;
  return { results, cnt, pass: ok === 1 && full === 1 && cnt === 15 };
}

(async () => {
  let exitCode = 0;
  try {
    await teardown(); // clears leftovers from a crashed earlier run

    const login = await api('POST', '/api/auth/login', null, LECTURER);
    if (!login.json || !login.json.token) throw new Error('Lecturer login failed: ' + JSON.stringify(login));
    const token = login.json.token;

    const fx = await setup();
    console.log(`Fixture: group ${GROUP_NAME} (id ${fx.groupId}), capacity 15, 14 members, 2 students waiting.`);
    console.log(`Each pair is repeated ${ROUNDS} times from a reset fixture.\n`);

    const rows = [];
    const failures = [];
    for (const kinds of PAIRS) {
      let passed = 0, maxMembers = 0, finalMembers = 0;
      for (let n = 1; n <= ROUNDS; n++) {
        const r = await round(fx, token, kinds);
        maxMembers = Math.max(maxMembers, r.cnt);
        finalMembers = r.cnt;
        if (r.pass) passed++;
        else failures.push(`${kinds.join(' + ')}, round ${n}: ${r.results.join(' / ')} (members in group: ${r.cnt})`);
      }
      rows.push({
        'client A + client B': kinds.join(' + '),
        rounds: ROUNDS,
        passed,
        'max members seen': maxMembers,
        'final members': finalMembers,
        result: passed === ROUNDS && maxMembers === 15 ? 'PASS' : 'FAIL',
      });
    }

    console.table(rows);
    if (failures.length) {
      exitCode = 1;
      console.log('Failures:');
      failures.forEach((f) => console.log('  ' + f));
    } else {
      console.log('All rounds passed: exactly one client got the last place, the other received GROUP_FULL, and the group never exceeded 15.');
    }

    if (KEEP) {
      console.log(`\nFixture kept. Query it with:\n  SELECT COUNT(*) FROM studentREG WHERE student_group = ${fx.groupId} AND deleted = 0;`);
      console.log('Run the script again (without --keep) to clean up.');
    }
  } catch (err) {
    console.error('Test run failed:', err.message);
    exitCode = 1;
  } finally {
    try {
      if (opIds.length) await pool.query('DELETE FROM operations WHERE op_id IN (?)', [opIds]);
      if (!KEEP) await teardown();
    } catch (err) {
      console.error('Cleanup failed:', err.message);
    }
    await pool.end();
    process.exitCode = exitCode;
  }
})();
