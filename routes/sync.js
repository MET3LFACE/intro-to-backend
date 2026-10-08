const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool, STUDENT_COLS } = require('../db');
const requireRole = require('../middleware/requireRole');

router.use(requireRole('lecturer'));

const NUMBER_RE = /^\d{9}$/;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s'.,-]*$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const validName = (n) => n.length >= 2 && n.length <= 100 && NAME_RE.test(n);

// Same content always gives the same string, whatever the key order
const stable = (v) => {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (typeof v === 'object')
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
const hashOp = (op) =>
  crypto.createHash('sha256')
    .update(stable({ type: op.type, studentId: op.studentId, baseVersion: op.baseVersion, payload: op.payload }))
    .digest('hex');

const rejected = (code, message) => ({ status: 'rejected', code, message });

const fetchStudent = async (conn, id) => {
  const [rows] = await conn.query(`SELECT ${STUDENT_COLS} FROM studentREG WHERE student_id = ?`, [id]);
  return rows[0];
};

// Validates the fields of a payload and returns the SQL pieces
async function buildChanges(conn, p) {
  const sets = [], params = [];
  let groupId; // undefined = leave alone, null = unassign
  if (p.name !== undefined) {
    const n = clean(p.name);
    if (!validName(n)) return { error: 'name must be 2-100 characters.' };
    sets.push('student_name = ?'); params.push(n);
  }
  if (p.studentNumber !== undefined) {
    const n = clean(p.studentNumber);
    if (!NUMBER_RE.test(n)) return { error: 'studentNumber must be exactly nine digits.' };
    sets.push('student_no = ?'); params.push(n);
  }
  if (p.email !== undefined) {
    const e = clean(p.email).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(e)) return { error: 'email is not valid.' };
    sets.push('student_email = ?'); params.push(e);
  }
  if (p.phone !== undefined) {
    if (p.phone !== null && String(p.phone).length > 10) return { error: 'phone must be at most 10 characters.' };
    sets.push('phone_No = ?'); params.push(p.phone === null ? null : String(p.phone));
  }
  if (p.program !== undefined) {
    if (p.program !== null) {
      const [rows] = await conn.query('SELECT 1 FROM programmes WHERE code = ?', [p.program]);
      if (!rows.length) return { error: 'program must be CS, IT or DS.' };
    }
    sets.push('program = ?'); params.push(p.program);
  }
  if (p.groupId !== undefined) {
    if (p.groupId !== null && !Number.isInteger(p.groupId)) return { error: 'groupId must be a whole number or null.' };
    groupId = p.groupId;
  }
  return { sets, params, groupId };
}

const lockGroup = async (conn, groupId) => {
  const [[g]] = await conn.query('SELECT * FROM student_groups WHERE group_id = ? FOR UPDATE', [groupId]);
  return g;
};
const othersInGroup = async (conn, groupId, studentId) => {
  const [[{ cnt }]] = await conn.query(
    'SELECT COUNT(*) AS cnt FROM studentREG WHERE student_group = ? AND deleted = 0 AND student_id <> ?',
    [groupId, studentId]);
  return cnt;
};

// ---------- the three operation types ----------
async function applyCreate(conn, op) {
  const p = op.payload || {};
  if (p.name === undefined || p.studentNumber === undefined || p.email === undefined)
    return rejected('VALIDATION', 'name, studentNumber and email are required.');
  const ch = await buildChanges(conn, p);
  if (ch.error) return rejected('VALIDATION', ch.error);

  const name = clean(p.name), number = clean(p.studentNumber), email = clean(p.email).toLowerCase();

  // Lock the group before reading or writing students, so every path locks in the same order
  if (ch.groupId) {
    const group = await lockGroup(conn, ch.groupId);
    if (!group) return rejected('GROUP_NOT_FOUND', 'Group not found.');
    if ((await othersInGroup(conn, ch.groupId, 0)) + 1 > group.capacity)
      return rejected('GROUP_FULL', 'Group is full.');
  }

  const [[existing]] = await conn.query('SELECT student_id, deleted FROM studentREG WHERE student_no = ? FOR UPDATE', [number]);
  if (existing)
    return existing.deleted
      ? rejected('STUDENT_DELETED', 'This student number belongs to a deleted record and stays reserved.')
      : rejected('DUPLICATE', 'A student with this number already exists.');

  // No password is sent from the phone; the student sets their own when they claim the profile
  const unusable = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
  try {
    const [r] = await conn.query(
      `INSERT INTO studentREG (student_no, student_name, student_email, student_pw, phone_No, program, student_group, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [number, name, email, unusable, p.phone ?? null, p.program ?? null, ch.groupId ?? null, new Date()]);
    return { status: 'applied', student: await fetchStudent(conn, r.insertId) };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return rejected('DUPLICATE', 'studentNumber or email already exists.');
    throw err;
  }
}

async function applyUpdate(conn, op) {
  const id = Number(op.studentId);
  if (!Number.isInteger(id) || !Number.isInteger(op.baseVersion))
    return rejected('VALIDATION', 'studentId and baseVersion must be whole numbers.');
  const ch = await buildChanges(conn, op.payload || {});
  if (ch.error) return rejected('VALIDATION', ch.error);
  if (!ch.sets.length && ch.groupId === undefined) return rejected('VALIDATION', 'No fields to update.');

  // Group first, then student: same order as every other path
  let group = null;
  if (ch.groupId) {
    group = await lockGroup(conn, ch.groupId);
    if (!group) return rejected('GROUP_NOT_FOUND', 'Group not found.');
  }

  const [[row]] = await conn.query('SELECT * FROM studentREG WHERE student_id = ? FOR UPDATE', [id]);
  if (!row) return rejected('NOT_FOUND', 'Student not found.');
  if (row.deleted) return rejected('STUDENT_DELETED', 'This student was deleted; the edit was not applied.');
  if (row.version !== op.baseVersion)
    return { status: 'conflict', code: 'VERSION_CONFLICT', current: await fetchStudent(conn, id) };

  const sets = [...ch.sets], params = [...ch.params];
  if (ch.groupId !== undefined) {
    if (ch.groupId !== null && ch.groupId !== row.student_group &&
        (await othersInGroup(conn, ch.groupId, id)) + 1 > group.capacity)
      return rejected('GROUP_FULL', 'Group is full; the previous group was kept.');
    sets.push('student_group = ?'); params.push(ch.groupId);
  }
  sets.push('version = version + 1', 'updated_at = ?');
  params.push(new Date(), id);

  try {
    await conn.query(`UPDATE studentREG SET ${sets.join(', ')} WHERE student_id = ?`, params);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return rejected('DUPLICATE', 'studentNumber or email already exists.');
    throw err;
  }
  return { status: 'applied', student: await fetchStudent(conn, id) };
}

async function applyDelete(conn, op, accountId) {
  const id = Number(op.studentId);
  if (!Number.isInteger(id)) return rejected('VALIDATION', 'studentId must be a whole number.');

  const [[row]] = await conn.query('SELECT * FROM studentREG WHERE student_id = ? FOR UPDATE', [id]);
  if (!row) return rejected('NOT_FOUND', 'Student not found.');
  if (row.deleted) return { status: 'applied', alreadyDeleted: true, student: await fetchStudent(conn, id) };
  if (op.baseVersion !== undefined && row.version !== op.baseVersion)
    return { status: 'conflict', code: 'VERSION_CONFLICT', current: await fetchStudent(conn, id) };

  await conn.query(
    `UPDATE studentREG SET deleted = 1, student_group = NULL, deleted_at = ?, deleted_by = ?,
       version = version + 1, updated_at = ? WHERE student_id = ?`,
    [new Date(), accountId, new Date(), id]);
  await conn.query('UPDATE users SET disabled = 1 WHERE student_id = ?', [id]);
  return { status: 'applied', student: await fetchStudent(conn, id) };
}

// ---------- receipts and one-operation-per-transaction runner ----------
async function lookupReceipt(conn, accountId, op, hash) {
  const [[r]] = await conn.query('SELECT account_id, payload_hash, result FROM operations WHERE op_id = ?', [op.opId]);
  if (!r) return null;
  if (r.account_id !== accountId || r.payload_hash !== hash)
    return { opId: op.opId, ...rejected('OPERATION_ID_REUSED', 'This operationId was already used with different content.') };
  const stored = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
  return { ...stored, replayed: true };
}

async function runOperation(accountId, op) {
  if (!op || typeof op.opId !== 'string' || !UUID_RE.test(op.opId) || !['create', 'update', 'delete'].includes(op.type))
    return { opId: op && op.opId, ...rejected('VALIDATION', 'opId must be a UUID and type must be create, update or delete.') };

  const hash = hashOp(op);
  const conn = await pool.getConnection();
  try {
    const seen = await lookupReceipt(conn, accountId, op, hash);
    if (seen) return seen;

    await conn.beginTransaction();
    const outcome = op.type === 'create' ? await applyCreate(conn, op)
                  : op.type === 'update' ? await applyUpdate(conn, op)
                  : await applyDelete(conn, op, accountId);
    const result = { opId: op.opId, ...outcome };

    // The receipt is written in the same transaction as the change, so they succeed or fail together
    try {
      await conn.query(
        'INSERT INTO operations (op_id, account_id, op_type, payload_hash, result, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [op.opId, accountId, op.type, hash, JSON.stringify(result), new Date()]);
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await conn.rollback();                       // a simultaneous retry won the race
      return (await lookupReceipt(conn, accountId, op, hash)) || result;
    }
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

// PULL: GET /api/sync?since=2026-10-01T00:00:00.000Z  (includes deleted records so devices can remove them)
router.get('/', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : new Date(0);
    if (isNaN(since)) return res.status(400).json({ error: 'Invalid since date.' });
    const serverTime = new Date();
    const [changes] = await pool.query(
      `SELECT ${STUDENT_COLS} FROM studentREG WHERE updated_at > ? ORDER BY updated_at`, [since]);
    res.json({ changes, serverTime: serverTime.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// PUSH: POST /api/sync  { "operations": [ { opId, type, studentId?, baseVersion?, payload? } ] }
router.post('/', async (req, res) => {
  const ops = req.body.operations;
  if (!Array.isArray(ops) || !ops.length || ops.length > 100)
    return res.status(400).json({ error: 'operations must be an array of 1 to 100 items.' });

  const results = [];
  try {
    for (const op of ops) results.push(await runOperation(req.user.id, op)); // in order
    res.json({ results, serverTime: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    // Earlier operations are already saved. The client retries the whole batch with the same IDs.
    res.status(500).json({ error: 'Something went wrong.', completed: results });
  }
});

module.exports = router;