const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');

const isValidEmail = (e) => typeof e === 'string' && /^\S+@\S+\.\S+$/.test(e);

router.post('/register', async (req, res) => {
  const { email, password, claimCode, name, program } = req.body;
  const studentNumber = typeof req.body.studentNumber === 'string' ? req.body.studentNumber.trim() : '';

  if (!isValidEmail(email) || typeof password !== 'string' || password.length < 8)
    return res.status(400).json({ error: 'Valid email and a password of at least 8 characters are required.' });
  if (!/^\d{9}$/.test(studentNumber))
    return res.status(400).json({ error: 'studentNumber must be exactly nine digits.' });
  if (typeof claimCode !== 'string' || !claimCode.trim())
    return res.status(400).json({ error: 'claimCode is required.' });

  const hash = await bcrypt.hash(password, 12);
  const normalized = email.toLowerCase();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Verify ownership: the code must match this student number and be unused
    const [[claim]] = await conn.query(
      'SELECT * FROM claim_codes WHERE code = ? FOR UPDATE', [claimCode.trim()]);
    if (!claim || claim.student_no !== studentNumber) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid claim code or student number.' });
    }
    if (claim.used_by) {
      await conn.rollback();
      return res.status(409).json({ error: 'This claim code has already been used.' });
    }

    // 2. Link to the existing profile if the lecturer already entered this student
    const [[existing]] = await conn.query(
      'SELECT student_id, deleted FROM studentREG WHERE student_no = ? FOR UPDATE', [studentNumber]);

    let studentId;
    if (existing) {
      if (existing.deleted) {
        await conn.rollback();
        return res.status(403).json({ error: 'This student record is closed. Contact a lecturer.' });
      }
      const [[taken]] = await conn.query('SELECT id FROM users WHERE student_id = ?', [existing.student_id]);
      if (taken) {
        await conn.rollback();
        return res.status(409).json({ error: 'This student already has an account.' });
      }
      studentId = existing.student_id;
    } else {
      // 3. No profile yet: create exactly one from the registration details
      const cleanName = typeof name === 'string' ? name.trim() : '';
      if (cleanName.length < 2 || cleanName.length > 100 || !['CS', 'IT', 'DS'].includes(program)) {
        await conn.rollback();
        return res.status(400).json({ error: 'name (2-100 characters) and program (CS, IT or DS) are required.' });
      }
      const [created] = await conn.query(
        `INSERT INTO studentREG (student_no, student_name, student_email, student_pw, program, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [studentNumber, cleanName, normalized, hash, program, new Date()]);
      studentId = created.insertId;
    }

    // 4. Create the account (always role student) and burn the claim code
    const userId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO users (id, email, password_hash, created_at, role, student_id)
       VALUES (?, ?, ?, ?, 'student', ?)`,
      [userId, normalized, hash, new Date(), studentId]);
    await conn.query('UPDATE claim_codes SET used_by = ?, used_at = ? WHERE code = ?',
      [userId, new Date(), claim.code]);

    await conn.commit();
    res.status(201).json({ id: userId, email: normalized, studentId });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already registered.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  } finally {
    conn.release();
  }
});
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
    const user = rows[0];
    const ok = user && !user.disabled && (await bcrypt.compare(String(password), user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;