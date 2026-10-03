const router = require('express').Router();
const bcrypt = require('bcrypt');
const { pool, STUDENT_COLS } = require('../db');

// PULL: GET /api/sync?since=2026-10-01T00:00:00.000Z
router.get('/', async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(0);
  if (isNaN(since)) return res.status(400).json({ error: 'Invalid since date.' });

  const serverTime = new Date();
  const [changes] = await pool.query(
    `SELECT ${STUDENT_COLS} FROM studentREG WHERE updated_at > ? ORDER BY updated_at`, [since]);
  res.json({ changes, serverTime: serverTime.toISOString() });
});

// PUSH: POST /api/sync
// { "students": [ { studentNumber, name, email, phone, program, groupId, deleted, updatedAt, password? } ] }
router.post('/', async (req, res) => {
  const incoming = req.body.students;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'students array required.' });

  const conn = await pool.getConnection();
  let applied = 0, skipped = 0;
  try {
    await conn.beginTransaction();
    for (const item of incoming) {
      const clientTime = new Date(item.updatedAt);
      if (!item.studentNumber || String(item.studentNumber).length !== 9 || !item.name || !item.email || isNaN(clientTime)) {
        skipped++; continue;
      }
      const sn = String(item.studentNumber);
      const [[existing]] = await conn.query('SELECT updated_at FROM studentREG WHERE student_no = ?', [sn]);

      if (!existing) {
        if (typeof item.password !== 'string' || item.password.length < 8) { skipped++; continue; }
        await conn.query(
          `INSERT INTO studentREG
             (student_no, student_name, student_email, student_pw, phone_No, program, student_group, deleted, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [sn, item.name, item.email.toLowerCase(), await bcrypt.hash(item.password, 12),
           item.phone || null, item.program || null, item.groupId || null, item.deleted ? 1 : 0, clientTime]);
        applied++;
      } else if (clientTime > existing.updated_at) { // last-write-wins
        await conn.query(
          `UPDATE studentREG SET student_name=?, student_email=?, phone_No=?, program=?,
             student_group=?, deleted=?, updated_at=? WHERE student_no = ?`,
          [item.name, item.email.toLowerCase(), item.phone || null, item.program || null,
           item.groupId || null, item.deleted ? 1 : 0, clientTime, sn]);
        applied++;
      } else skipped++;
    }
    await conn.commit();
    res.json({ applied, skipped, serverTime: new Date().toISOString() });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    const status = err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_DUP_ENTRY' ? 409 : 500;
    res.status(status).json({ error: 'Sync failed; no changes were applied.', detail: err.code });
  } finally {
    conn.release();
  }
});

module.exports = router;