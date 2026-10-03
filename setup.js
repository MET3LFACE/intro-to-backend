require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });
  await conn.query(fs.readFileSync('schema.sql', 'utf8'));
  console.log('Schema created.');
  await conn.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });