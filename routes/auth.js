const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');

const isValidEmail = (e) => typeof e === 'string' && /^\S+@\S+\.\S+$/.test(e);

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!isValidEmail(email) || typeof password !== 'string' || password.length < 8)
      return res.status(400).json({ error: 'Valid email and a password of at least 8 characters are required.' });

    const id = crypto.randomUUID();
    const normalized = email.toLowerCase();
    const hash = await bcrypt.hash(password, 12);

    await pool.query(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
      [id, normalized, hash, new Date()]
    );
    res.status(201).json({ id, email: normalized });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already registered.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(String(password), user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;