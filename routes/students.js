const requireRole = require('../middleware/requireRole');
const router = require('express').Router();
const bcrypt = require('bcrypt');
const { pool, STUDENT_COLS } = require('../db');

const getStudent = async (id) => {
  const [rows] = await pool.query(
    `SELECT ${STUDENT_COLS} FROM studentREG WHERE student_id = ? AND deleted = 0`, [id]);
  return rows[0];
};

router.get('/me', requireRole('student'), async (req, res) => {
  try {
    if (!req.user.studentId) return res.status(404).json({ error: 'No student profile linked to this account.' });
    const student = await getStudent(req.user.studentId);
    if (!student) return res.status(404).json({ error: 'Student profile not found.' });

    let group = null;
    if (student.groupId) {
      const [[g]] = await pool.query(
        `SELECT g.group_id AS id, g.group_name AS name, g.capacity,
                (SELECT COUNT(*) FROM studentREG s WHERE s.student_group = g.group_id AND s.deleted = 0) AS members
         FROM student_groups g WHERE g.group_id = ?`, [student.groupId]);
      group = g || null;
    }
    res.json({ ...student, group });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.put('/me', requireRole('student'), async (req, res) => {
  try {
    if (!req.user.studentId) return res.status(404).json({ error: 'No student profile linked to this account.' });
    for (const f of ['studentNumber', 'email', 'groupId', 'group'])
      if (req.body[f] !== undefined)
        return res.status(403).json({ error: `You cannot change ${f} directly. Submit a request to a lecturer.` });

    const sets = [], params = [];
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'name must be 2-100 characters.' });
      sets.push('student_name = ?'); params.push(name);
    }
    if (req.body.program !== undefined) {
      if (!['CS', 'IT', 'DS'].includes(req.body.program)) return res.status(400).json({ error: 'program must be CS, IT or DS.' });
      sets.push('program = ?'); params.push(req.body.program);
    }
    if (req.body.phone !== undefined) { sets.push('phone_No = ?'); params.push(req.body.phone); }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields to update.' });

    sets.push('updated_at = ?');
    params.push(new Date(), req.user.studentId);
    const [result] = await pool.query(
      `UPDATE studentREG SET ${sets.join(', ')} WHERE student_id = ? AND deleted = 0`, params);
    if (!result.affectedRows) return res.status(404).json({ error: 'Student profile not found.' });
    res.json(await getStudent(req.user.studentId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});


router.use(requireRole('lecturer'));

router.post('/', async (req, res) => {
  try {
    const { name, studentNumber, email, password, phone, program } = req.body;
    if (!name || !studentNumber || !email || typeof password !== 'string' || password.length < 8)
      return res.status(400).json({ error: 'name, studentNumber, email and a password of at least 8 characters are required.' });
    if (String(studentNumber).length !== 9)
      return res.status(400).json({ error: 'studentNumber must be exactly 9 characters.' });

    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      `INSERT INTO studentREG (student_no, student_name, student_email, student_pw, phone_No, program, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [String(studentNumber), name, email.toLowerCase(), hash, phone || null, program || null, new Date()]
    );
    res.status(201).json(await getStudent(result.insertId));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'studentNumber or email already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// READ ALL + SEARCH/FILTER/PAGINATION
// GET /api/students?q=john&program=CS&groupId=1&unassigned=true&page=1&limit=10
router.get('/', async (req, res) => {
  try {
    const { q, program, groupId, unassigned } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));

    const where = ['deleted = 0'];
    const params = [];
    if (q) {
      where.push('(student_name LIKE ? OR student_no LIKE ? OR student_email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (program) { where.push('program = ?');       params.push(program); }
    if (groupId) { where.push('student_group = ?'); params.push(Number(groupId)); }
    if (unassigned === 'true') where.push('student_group IS NULL');

    const clause = where.join(' AND ');
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM studentREG WHERE ${clause}`, params);
    const [data] = await pool.query(
      `SELECT ${STUDENT_COLS} FROM studentREG WHERE ${clause} ORDER BY student_name LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ total, page, pages: Math.ceil(total / limit), data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// READ ONE
router.get('/:id', async (req, res) => {
  const s = await getStudent(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: 'Student not found.' });
});

// UPDATE (whitelisted fields only)
router.put('/:id', async (req, res) => {
  try {
    const map = { name: 'student_name', studentNumber: 'student_no', email: 'student_email',
                  phone: 'phone_No', program: 'program' };
    const sets = [], params = [];
    for (const [key, col] of Object.entries(map)) {
      if (req.body[key] !== undefined) { sets.push(`${col} = ?`); params.push(req.body[key]); }
    }
    if (req.body.password !== undefined) {
      if (typeof req.body.password !== 'string' || req.body.password.length < 8)
        return res.status(400).json({ error: 'password must be at least 8 characters.' });
      sets.push('student_pw = ?');
      params.push(await bcrypt.hash(req.body.password, 12));
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields to update.' });

    sets.push('updated_at = ?');
    params.push(new Date(), req.params.id);
    const [result] = await pool.query(
      `UPDATE studentREG SET ${sets.join(', ')} WHERE student_id = ? AND deleted = 0`, params);
    if (!result.affectedRows) return res.status(404).json({ error: 'Student not found.' });
    res.json(await getStudent(req.params.id));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'studentNumber or email already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.delete('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'UPDATE studentREG SET deleted = 1, student_group = NULL, updated_at = ? WHERE student_id = ? AND deleted = 0',
      [new Date(), req.params.id]);
    if (!result.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ error: 'Student not found.' });
    }
    await conn.query('UPDATE users SET disabled = 1 WHERE student_id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).end();
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  } finally {
    conn.release();
  }
});
module.exports = router;