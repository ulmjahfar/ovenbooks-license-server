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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_keys (
      id SERIAL PRIMARY KEY,
      license_key TEXT UNIQUE,
      plan TEXT,
      days INTEGER,
      is_used BOOLEAN DEFAULT false,
      used_device TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      device_id TEXT,
      device_name TEXT,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS device_limit INTEGER DEFAULT 1;
  `);

  await pool.query(`
    ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT false;
  `);

  console.log("Tables ready");
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
    // Step 1: Find device (if registered in devices table) and check blocked status
    const deviceResult = await pool.query(
      'SELECT company_id, blocked FROM devices WHERE device_id = $1 LIMIT 1',
      [device_id]
    );
    if (deviceResult.rows.length > 0) {
      const device = deviceResult.rows[0];
      if (device.blocked) {
        return res.json({
          allowed: false,
          message: 'Device blocked'
        });
      }
    }

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

    // Device count check: devices_used <= device_limit
    const deviceLimit = company.device_limit ?? 1;
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS devices_used FROM devices WHERE company_id = $1',
      [company.id]
    );
    const devicesUsed = countResult.rows[0].devices_used;

    if (devicesUsed > deviceLimit) {
      return res.json({
        allowed: false,
        reason: 'Device limit exceeded',
        devices_used: devicesUsed,
        device_limit: deviceLimit
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

app.post("/admin/upgrade-license", async (req, res) => {
  const { device_id, billing_type, admin_secret } = req.body;

  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    let expiry = null;

    if (billing_type === "monthly") {
      expiry = new Date();
      expiry.setMonth(expiry.getMonth() + 1);
    }

    if (billing_type === "yearly") {
      expiry = new Date();
      expiry.setFullYear(expiry.getFullYear() + 1);
    }

    const result = await pool.query(
      `UPDATE companies
       SET billing_type=$1, expiry_date=$2
       WHERE device_id=$3
       RETURNING *`,
      [billing_type, expiry, device_id]
    );

    res.json({
      message: "License upgraded successfully",
      company: result.rows[0],
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/generate-key", async (req, res) => {
  try {
    const { plan, days, admin_secret } = req.body;

    if (admin_secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (plan == null || days == null) {
      return res.status(400).json({ error: "plan and days are required" });
    }

    function generateKey() {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let key = "OB-";
      for (let i = 0; i < 12; i++) {
        key += chars[Math.floor(Math.random() * chars.length)];
        if (i == 3 || i == 7) key += "-";
      }
      return key;
    }

    const key = generateKey();

    const result = await pool.query(
      `INSERT INTO product_keys (license_key, plan, days)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [key, plan, Number(days)]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("admin/generate-key error:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

app.post("/license/activate-key", async (req, res) => {

  const { device_id, license_key } = req.body;

  const key = await pool.query(
    "SELECT * FROM product_keys WHERE license_key=$1",
    [license_key]
  );

  if (key.rows.length === 0)
    return res.json({ allowed: false, message: "Invalid key" });

  const data = key.rows[0];

  if (data.is_used)
    return res.json({ allowed: false, message: "Key already used" });

  let expiry = null;

  if (data.days) {
    expiry = new Date();
    expiry.setDate(expiry.getDate() + data.days);
  }

  await pool.query(
    `UPDATE companies
     SET billing_type=$1,
         expiry_date=$2
     WHERE device_id=$3`,
    [data.plan, expiry, device_id]
  );

  await pool.query(
    `UPDATE product_keys
     SET is_used=true,
         used_device=$1
     WHERE license_key=$2`,
    [device_id, license_key]
  );

  res.json({ allowed: true, message: "License activated" });

});

app.get("/admin/companies", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM companies ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/admin/keys", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM product_keys ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("admin/keys error:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

// Block a device (admin) – sets devices.blocked = true; app gets allowed: false, message: "Device blocked"
app.post("/admin/block-device", async (req, res) => {
  const { device_id, admin_secret } = req.body;
  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  if (!device_id) {
    return res.status(400).json({ error: "device_id is required" });
  }
  try {
    const result = await pool.query(
      `UPDATE devices SET blocked = true WHERE device_id = $1 RETURNING *`,
      [device_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }
    res.json({ message: "Device blocked", device: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/device/block", async (req, res) => {
  const { device_id, admin_secret } = req.body;
  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  if (!device_id) {
    return res.status(400).json({ error: "device_id is required" });
  }
  try {
    const result = await pool.query(
      `UPDATE devices SET blocked = true WHERE device_id = $1 RETURNING *`,
      [device_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }
    res.json({ message: "Device blocked", device: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Unblock a device (admin)
app.post("/admin/device/unblock", async (req, res) => {
  const { device_id, admin_secret } = req.body;
  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  if (!device_id) {
    return res.status(400).json({ error: "device_id is required" });
  }
  try {
    const result = await pool.query(
      `UPDATE devices SET blocked = false WHERE device_id = $1 RETURNING *`,
      [device_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }
    res.json({ message: "Device unblocked", device: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Deactivate a device (no admin secret; used by app)
app.post("/device/deactivate", async (req, res) => {
  const { device_id } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: "device_id is required" });
  }

  try {
    const result = await pool.query(
      `UPDATE devices SET blocked = true WHERE device_id = $1 RETURNING *`,
      [device_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json({ message: "Device deactivated", device: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Remove a device (delete from devices table)
app.get("/device/remove", (req, res) => {
  res.status(405).json({
    error: "Method Not Allowed",
    message: "Use DELETE with JSON body: { \"device_id\": \"<id>\" }",
  });
});
app.delete("/device/remove", async (req, res) => {
  const { device_id } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: "device_id is required" });
  }

  try {
    const result = await pool.query(
      `DELETE FROM devices WHERE device_id = $1 RETURNING *`,
      [device_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json({ message: "Device removed", device: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/device/register", async (req, res) => {
  try {
    const { device_id, device_name, company_id } = req.body;

    // Resolve company: by company_id if provided, else by company's device_id
    let companyData;
    if (company_id != null) {
      const byId = await pool.query("SELECT * FROM companies WHERE id=$1", [company_id]);
      if (byId.rows.length === 0) {
        return res.json({ allowed: false, message: "Company not found" });
      }
      companyData = byId.rows[0];
    } else {
      const company = await pool.query(
        "SELECT * FROM companies WHERE device_id=$1",
        [device_id]
      );
      if (company.rows.length === 0) {
        return res.json({ allowed: false });
      }
      companyData = company.rows[0];
    }

    // If device_id already exists in devices, it must be for the same company
    const existingDevice = await pool.query(
      "SELECT company_id FROM devices WHERE device_id=$1 LIMIT 1",
      [device_id]
    );

    if (existingDevice.rows.length > 0) {
      const existingCompanyId = existingDevice.rows[0].company_id;
      if (existingCompanyId !== companyData.id) {
        return res.json({
          allowed: false,
          message: "Device already registered to another company"
        });
      }
      // Same company: update last_seen (and optionally device_name)
      await pool.query(
        `UPDATE devices SET last_seen=CURRENT_TIMESTAMP, device_name=COALESCE($2, device_name)
         WHERE device_id=$1`,
        [device_id, device_name]
      );
      return res.json({ allowed: true });
    }

    const devices = await pool.query(
      "SELECT * FROM devices WHERE company_id=$1",
      [companyData.id]
    );

    if (devices.rows.length >= (companyData.device_limit ?? 1)) {
      return res.json({
        allowed: false,
        message: "Device limit reached"
      });
    }

    await pool.query(
      `INSERT INTO devices (company_id, device_id, device_name)
       VALUES ($1, $2, $3)`,
      [companyData.id, device_id, device_name]
    );

    res.json({ allowed: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

// List devices for a company
app.get("/devices", async (req, res) => {
  try {
    const { company_id } = req.query;

    if (!company_id) {
      return res.status(400).json({ error: "company_id is required" });
    }

    const result = await pool.query(
      "SELECT * FROM devices WHERE company_id=$1 ORDER BY id DESC",
      [company_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});