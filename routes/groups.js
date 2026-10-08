const router = require('express').Router();
const { pool } = require('../db');
const requireRole = require('../middleware/requireRole');

// Any logged-in user may view groups and counts
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT g.group_id AS id, g.group_name AS name, g.capacity, COUNT(s.student_id) AS members
       FROM student_groups g
       LEFT JOIN studentREG s ON s.student_group = g.group_id AND s.deleted = 0
       GROUP BY g.group_id, g.group_name, g.capacity
       ORDER BY g.group_name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Everything below is lecturer-only
router.use(requireRole('lecturer'));

router.post('/', async (req, res) => {
  try {
    const { name, capacity = 5 } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required.' });
    if (!Number.isInteger(Number(capacity)) || Number(capacity) < 1 || Number(capacity) > 15)
      return res.status(400).json({ error: 'capacity must be a whole number from 1 to 15.' });

    const [result] = await pool.query(
      'INSERT INTO student_groups (group_name, capacity) VALUES (?, ?)', [name, Number(capacity)]);
    res.status(201).json({ id: result.insertId, name, capacity: Number(capacity) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Group name already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Assign: POST /api/groups/:id/assign  { "studentIds": [1, 2] }
router.post('/:id/assign', async (req, res) => {
  const ids = Array.isArray(req.body.studentIds)
    ? [...new Set(req.body.studentIds.map(Number))] : [];
  if (!ids.length || !ids.every(Number.isInteger))
    return res.status(400).json({ error: 'studentIds must be an array of whole numbers.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the group first, then the students, so every path locks in the same order
    const [[group]] = await conn.query('SELECT * FROM student_groups WHERE group_id = ? FOR UPDATE', [req.params.id]);
    if (!group) { await conn.rollback(); return res.status(404).json({ error: 'Group not found.' }); }

    const [students] = await conn.query(
      'SELECT student_id, student_group FROM studentREG WHERE student_id IN (?) AND deleted = 0 ORDER BY student_id FOR UPDATE', [ids]);
    if (students.length !== ids.length) { await conn.rollback(); return res.status(404).json({ error: 'One or more students not found.' }); }

    const [[{ current }]] = await conn.query(
      'SELECT COUNT(*) AS current FROM studentREG WHERE student_group = ? AND deleted = 0', [group.group_id]);
    const newcomers = students.filter((s) => s.student_group !== group.group_id).length;
    if (current + newcomers > group.capacity) { await conn.rollback(); return res.status(409).json({ error: 'GROUP_FULL' }); }

    await conn.query(
      'UPDATE studentREG SET student_group = ?, version = version + 1, updated_at = ? WHERE student_id IN (?)',
      [group.group_id, new Date(), ids]);
    await conn.commit();
    res.json({ assigned: ids.length });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  } finally {
    conn.release();
  }
});

// Remove from group
router.post('/unassign/:studentId', async (req, res) => {
  try {
    const [result] = await pool.query(
      'UPDATE studentREG SET student_group = NULL, version = version + 1, updated_at = ? WHERE student_id = ? AND deleted = 0',
      [new Date(), req.params.studentId]
    );
    result.affectedRows ? res.json({ message: 'Unassigned.' }) : res.status(404).json({ error: 'Student not found.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Auto-assign all unassigned students, filling groups up to capacity
router.post('/auto-assign', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT group_id FROM student_groups ORDER BY group_id FOR UPDATE');
    const [groups] = await conn.query(
      `SELECT g.group_id, g.capacity, COUNT(s.student_id) AS members
       FROM student_groups g
       LEFT JOIN studentREG s ON s.student_group = g.group_id AND s.deleted = 0
       GROUP BY g.group_id, g.capacity ORDER BY g.group_id`
    );
    const [unassigned] = await conn.query(
      'SELECT student_id FROM studentREG WHERE student_group IS NULL AND deleted = 0 ORDER BY student_name');

    let assigned = 0, i = 0;
    for (const g of groups) {
      let free = g.capacity - g.members;
      while (free > 0 && i < unassigned.length) {
        await conn.query(
          'UPDATE studentREG SET student_group = ?, version = version + 1, updated_at = ? WHERE student_id = ?',
          [g.group_id, new Date(), unassigned[i].student_id]);
        i++; free--; assigned++;
      }
    }
    await conn.commit();
    res.json({ assigned, remainingUnassigned: unassigned.length - assigned });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  } finally {
    conn.release();
  }
});

module.exports = router;