const jwt = require('jsonwebtoken');
const { pool } = require('../db');

module.exports = async function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Missing token.' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  try {
    const [[user]] = await pool.query(
      'SELECT id, email, role, student_id, disabled FROM users WHERE id = ?', [payload.sub]);
    if (!user || user.disabled) return res.status(401).json({ error: 'Account not available.' });
    req.user = { id: user.id, email: user.email, role: user.role, studentId: user.student_id };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
};