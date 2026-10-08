require('dotenv').config();
const express = require('express');
const requireAuth = require('./middleware/requireAuth');
const { pool } = require('./db');

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');

const app = express();
app.use(express.json());


app.use('/api/auth', require('./routes/auth'));
app.use('/api/students', requireAuth, require('./routes/students'));
app.use('/api/groups', requireAuth, require('./routes/groups'));
app.use('/api/sync', requireAuth, require('./routes/sync'));
const port = process.env.PORT || 3000;
pool.query('SELECT 1')
  .then(() => app.listen(port, () => console.log(`Server running on port ${port}`)))
  .catch((err) => { console.error('Database connection failed:', err.message); process.exit(1); });

  app.get('/api/me', requireAuth, (req, res) =>
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role, studentId: req.user.studentId }));
  app.use('/api/requests', requireAuth, require('./routes/requests'));