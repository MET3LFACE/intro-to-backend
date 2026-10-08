const router = require('express').Router();
const { pool } = require('../db');
const requireRole = require('../middleware/requireRole');

const NUMBER_RE = /^\d{9}$/;
const TABLES = { 'group-change': 'group_change_requests', 'number-correction': 'number_correction_requests' };
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'Something went wrong.' }); };

// ================= STUDENT =================
router.post('/group-change', requireRole('student'), async (req, res) => {
  try {
    if (!req.user.studentId) return res.status(404).json({ error: 'No student profile linked to this account.' });
    const groupId = toId(req.body.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId must be a whole number.' });

    const [[student]] = await pool.query(
      'SELECT student_group FROM studentREG WHERE student_id = ? AND deleted = 0', [req.user.studentId]);
    if (!student) return res.status(404).json({ error: 'Student profile not found.' });
    if (student.student_group === groupId) return res.status(400).json({ error: 'You are already in this group.' });
    const [[group]] = await pool.query('SELECT group_id FROM student_groups WHERE group_id = ?', [groupId]);
    if (!group) return res.status(404).json({ error: 'Group not found.' });

    // A request never reserves a place; capacity is checked when the lecturer approves
    const [r] = await pool.query(
      'INSERT INTO group_change_requests (student_id, requested_group, created_at) VALUES (?, ?, ?)',
      [req.user.studentId, groupId, new Date()]);
    res.status(201).json({ id: r.insertId, status: 'pending', requestedGroup: groupId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'You already have a pending group change request.' });
    fail(res, err);
  }
});

router.post('/number-correction', requireRole('student'), async (req, res) => {
  try {
    if (!req.user.studentId) return res.status(404).json({ error: 'No student profile linked to this account.' });
    const number = typeof req.body.studentNumber === 'string' ? req.body.studentNumber.trim() : '';
    if (!NUMBER_RE.test(number)) return res.status(400).json({ error: 'studentNumber must be exactly nine digits.' });

    const [[student]] = await pool.query(
      'SELECT student_no FROM studentREG WHERE student_id = ? AND deleted = 0', [req.user.studentId]);
    if (!student) return res.status(404).json({ error: 'Student profile not found.' });
    if (student.student_no === number) return res.status(400).json({ error: 'That is already your student number.' });

    // No check against other students here, so a student cannot probe which numbers exist
    const [r] = await pool.query(
      'INSERT INTO number_correction_requests (student_id, requested_number, created_at) VALUES (?, ?, ?)',
      [req.user.studentId, number, new Date()]);
    res.status(201).json({ id: r.insertId, status: 'pending', requestedNumber: number });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'You already have a pending number correction request.' });
    fail(res, err);
  }
});

router.get('/mine', requireRole('student'), async (req, res) => {
  try {
    if (!req.user.studentId) return res.status(404).json({ error: 'No student profile linked to this account.' });
    const [groupChanges] = await pool.query(
      `SELECT id, requested_group AS requestedGroup, status, note, created_at AS createdAt, decided_at AS decidedAt
       FROM group_change_requests WHERE student_id = ? ORDER BY id DESC`, [req.user.studentId]);
    const [numberCorrections] = await pool.query(
      `SELECT id, requested_number AS requestedNumber, status, note, created_at AS createdAt, decided_at AS decidedAt
       FROM number_correction_requests WHERE student_id = ? ORDER BY id DESC`, [req.user.studentId]);
    res.json({ groupChanges, numberCorrections });
  } catch (err) { fail(res, err); }
});

// Students can cancel only their own pending requests
router.post('/:type/:id/cancel', requireRole('student'), async (req, res) => {
  try {
    const table = TABLES[req.params.type];
    const id = toId(req.params.id);
    if (!table || !id) return res.status(400).json({ error: 'Invalid request type or id.' });
    const [r] = await pool.query(
      `UPDATE ${table} SET status = 'cancelled', decided_at = ? WHERE id = ? AND student_id = ? AND status = 'pending'`,
      [new Date(), id, req.user.studentId]);
    r.affectedRows ? res.json({ id, status: 'cancelled' }) : res.status(404).json({ error: 'No pending request with this id.' });
  } catch (err) { fail(res, err); }
});

// ================= LECTURER =================
router.use(requireRole('lecturer'));

// GET /api/requests?status=pending
router.get('/', async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
    const [groupChanges] = await pool.query(
      `SELECT r.id, r.student_id AS studentId, s.student_no AS studentNumber, s.student_name AS name,
              s.student_group AS currentGroup, r.requested_group AS requestedGroup,
              r.status, r.note, r.created_at AS createdAt
       FROM group_change_requests r JOIN studentREG s ON s.student_id = r.student_id
       WHERE r.status = ? ORDER BY r.id`, [status]);
    const [numberCorrections] = await pool.query(
      `SELECT r.id, r.student_id AS studentId, s.student_no AS currentNumber, s.student_name AS name,
              r.requested_number AS requestedNumber, r.status, r.note, r.created_at AS createdAt
       FROM number_correction_requests r JOIN studentREG s ON s.student_id = r.student_id
       WHERE r.status = ? ORDER BY r.id`, [status]);
    res.json({ groupChanges, numberCorrections });
  } catch (err) { fail(res, err); }
});

// Approve a group change. Same lock order as every other group path: group first, then student.
router.post('/group-change/:id/approve', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[peek]] = await conn.query('SELECT requested_group FROM group_change_requests WHERE id = ?', [id]);
    if (!peek) { await conn.rollback(); return res.status(404).json({ error: 'Request not found.' }); }

    const [[group]] = await conn.query('SELECT * FROM student_groups WHERE group_id = ? FOR UPDATE', [peek.requested_group]);
    const [[reqRow]] = await conn.query('SELECT * FROM group_change_requests WHERE id = ? FOR UPDATE', [id]);
    if (reqRow.status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: `Request is already ${reqRow.status}.` });
    }
    const [[student]] = await conn.query('SELECT * FROM studentREG WHERE student_id = ? FOR UPDATE', [reqRow.student_id]);
    if (!student || student.deleted) {
      await conn.query(
        "UPDATE group_change_requests SET status = 'rejected', note = ?, decided_at = ?, decided_by = ? WHERE id = ?",
        ['Student was deleted.', new Date(), req.user.id, id]);
      await conn.commit();
      return res.status(409).json({ error: 'STUDENT_DELETED' });
    }

    if (student.student_group !== group.group_id) {
      const [[{ cnt }]] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM studentREG WHERE student_group = ? AND deleted = 0 AND student_id <> ?',
        [group.group_id, student.student_id]);
      if (cnt + 1 > group.capacity) {
        await conn.rollback(); // request stays pending and the old group is kept
        return res.status(409).json({ error: 'GROUP_FULL', message: 'The group is full; the request stays pending.' });
      }
      await conn.query(
        'UPDATE studentREG SET student_group = ?, version = version + 1, updated_at = ? WHERE student_id = ?',
        [group.group_id, new Date(), student.student_id]);
    }
    await conn.query(
      "UPDATE group_change_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?",
      [new Date(), req.user.id, id]);
    await conn.commit();
    res.json({ id, status: 'approved', studentId: student.student_id, groupId: group.group_id });
  } catch (err) {
    await conn.rollback();
    fail(res, err);
  } finally {
    conn.release();
  }
});

// Approve a student-number correction
router.post('/number-correction/:id/approve', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[reqRow]] = await conn.query('SELECT * FROM number_correction_requests WHERE id = ? FOR UPDATE', [id]);
    if (!reqRow) { await conn.rollback(); return res.status(404).json({ error: 'Request not found.' }); }
    if (reqRow.status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: `Request is already ${reqRow.status}.` });
    }
    const [[student]] = await conn.query('SELECT * FROM studentREG WHERE student_id = ? FOR UPDATE', [reqRow.student_id]);
    if (!student || student.deleted) {
      await conn.query(
        "UPDATE number_correction_requests SET status = 'rejected', note = ?, decided_at = ?, decided_by = ? WHERE id = ?",
        ['Student was deleted.', new Date(), req.user.id, id]);
      await conn.commit();
      return res.status(409).json({ error: 'STUDENT_DELETED' });
    }
    try {
      await conn.query(
        'UPDATE studentREG SET student_no = ?, version = version + 1, updated_at = ? WHERE student_id = ?',
        [reqRow.requested_number, new Date(), student.student_id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        await conn.rollback();
        return res.status(409).json({ error: 'NUMBER_TAKEN', message: 'Another record already uses this number.' });
      }
      throw err;
    }
    await conn.query(
      "UPDATE number_correction_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?",
      [new Date(), req.user.id, id]);
    await conn.commit();
    res.json({ id, status: 'approved', studentId: student.student_id, studentNumber: reqRow.requested_number });
  } catch (err) {
    await conn.rollback();
    fail(res, err);
  } finally {
    conn.release();
  }
});

// Reject either type, with an optional note
router.post('/:type/:id/reject', async (req, res) => {
  try {
    const table = TABLES[req.params.type];
    const id = toId(req.params.id);
    if (!table || !id) return res.status(400).json({ error: 'Invalid request type or id.' });
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 255) : null;
    const [r] = await pool.query(
      `UPDATE ${table} SET status = 'rejected', note = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`,
      [note || null, new Date(), req.user.id, id]);
    r.affectedRows ? res.json({ id, status: 'rejected' }) : res.status(404).json({ error: 'No pending request with this id.' });
  } catch (err) { fail(res, err); }
});

module.exports = router;