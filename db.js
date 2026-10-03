const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',
});

const STUDENT_COLS = `student_id AS id, student_no AS studentNumber, student_name AS name,
  student_email AS email, phone_No AS phone, program,
  student_group AS groupId, deleted, updated_at AS updatedAt`;

module.exports = { pool, STUDENT_COLS };