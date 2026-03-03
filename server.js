const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto create companies table
async function createTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      device_id TEXT UNIQUE NOT NULL,
      billing_type TEXT DEFAULT 'trial',
      expiry_date TIMESTAMP,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log("Companies table ready ✅");
}

createTable();

// Test route
app.get('/', (req, res) => {
  res.send('OvenBooks License Server Running 🚀');
});

// DB test
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ serverTime: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register company (create trial if new)
app.post('/company/register', async (req, res) => {
  const { name, device_id } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    // Check if device already exists
    const existing = await pool.query(
      'SELECT * FROM companies WHERE device_id = $1',
      [device_id]
    );

    if (existing.rows.length > 0) {
      return res.json({
        message: 'Company already registered',
        company: existing.rows[0]
      });
    }

    // Create 7-day trial
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);

    const result = await pool.query(
      `INSERT INTO companies (name, device_id, expiry_date)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name || 'OvenBooks Company', device_id, expiry]
    );

    res.json({
      message: 'Trial created successfully',
      company: result.rows[0]
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// License check
app.post('/license/check', async (req, res) => {
  const { device_id } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM companies WHERE device_id = $1',
      [device_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const company = result.rows[0];
    const now = new Date();

    if (!company.is_active) {
      return res.json({
        allowed: false,
        reason: 'Company is blocked'
      });
    }

    if (company.expiry_date && now > company.expiry_date) {
      return res.json({
        allowed: false,
        reason: 'License expired',
        expiry_date: company.expiry_date
      });
    }

    res.json({
      allowed: true,
      billing_type: company.billing_type,
      expiry_date: company.expiry_date
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});