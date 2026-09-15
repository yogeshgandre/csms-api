// routes/admin.js — Seva_Dept / Seva_Dept_Role / Seva_Dept_Role_HRCHY management.
//
// Versioning convention (per project decisions log — NOT "IS NULL"):
//   insert:  Ver_From_DT = CURRENT_DATE, Ver_To_DT = '9999-12-31'
//   update:  supersede the old row (its Ver_To_DT -> yesterday), insert new
//
// AUTHORIZATION WARNING: these are structural/destructive endpoints —
// creating departments, creating roles, rewriting hierarchy — gated only by
// requireAuth (any signed-in CSMS user with at least one active role
// anywhere). There is no separate "admin" privilege concept anywhere in the
// schema you provided, so none is enforced here. Any invited user can
// currently create departments and roles. Flagging this loudly rather than
// letting the endpoint names imply a safety that isn't there — if only
// specific people should manage structure, that needs a real admin flag
// (on User_Profile? a reserved Dept_Role_Name convention?) before this goes
// near production.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const FAR_FUTURE = '9999-12-31';

// POST /api/admin/depts — create a Seva Department
router.post('/depts', requireAuth, async (req, res) => {
  const { name, parentId } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO ${qi('RMS')}.${qi('Seva_Dept')}
        (${qi('Seva_Dept_Name')}, ${qi('Parent_Seva_Dept_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, CURRENT_DATE, $3)
       RETURNING ${qi('Seva_Dept_ID')}`,
      [name, parentId || null, FAR_FUTURE]
    );
    res.status(201).json({ sevaDeptId: result.rows[0].Seva_Dept_ID });
  } catch (err) {
    console.error('[POST /admin/depts] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/admin/depts/:id/roles — roles in a dept, with current hierarchy rank
router.get('/depts/:id/roles', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.${qi('Dept_Role_ID')}, r.${qi('Dept_Role_Name')}, r.${qi('Dept_Role_Desc')},
              h.${qi('HRCHY_ID')}
       FROM ${qi('RMS')}.${qi('Seva_Dept_Role')} r
       LEFT JOIN ${qi('RMS')}.${qi('Seva_Dept_Role_HRCHY')} h
         ON h.${qi('Dept_Role_ID')} = r.${qi('Dept_Role_ID')}
         AND h.${qi('Seva_Dept_ID')} = r.${qi('Seva_Dept_ID')}
         AND h.${qi('Ver_To_DT')} >= CURRENT_DATE
       WHERE r.${qi('Seva_Dept_ID')} = $1 AND r.${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY h.${qi('HRCHY_ID')} NULLS LAST, r.${qi('Dept_Role_Name')}`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /admin/depts/:id/roles] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// POST /api/admin/roles — create a role within a department
router.post('/roles', requireAuth, async (req, res) => {
  const { sevaDeptId, name, desc } = req.body || {};
  if (!sevaDeptId || !name) {
    return res.status(400).json({ error: 'sevaDeptId and name are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO ${qi('RMS')}.${qi('Seva_Dept_Role')}
        (${qi('Seva_Dept_ID')}, ${qi('Dept_Role_Name')}, ${qi('Dept_Role_Desc')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, $3, CURRENT_DATE, $4)
       RETURNING ${qi('Dept_Role_ID')}`,
      [sevaDeptId, name, desc || '', FAR_FUTURE]
    );
    res.status(201).json({ deptRoleId: result.rows[0].Dept_Role_ID });
  } catch (err) {
    console.error('[POST /admin/roles] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// POST /api/admin/hierarchy — set (or change) a role's rank within its dept.
// Supersedes any existing active row for this (dept, role) pair rather than
// leaving two "active" rows around, per the versioning convention.
router.post('/hierarchy', requireAuth, async (req, res) => {
  const { sevaDeptId, deptRoleId, hrchyId } = req.body || {};
  if (!sevaDeptId || !deptRoleId || hrchyId == null) {
    return res.status(400).json({ error: 'sevaDeptId, deptRoleId and hrchyId are required' });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    await client.query(
      `UPDATE ${qi('RMS')}.${qi('Seva_Dept_Role_HRCHY')}
       SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Seva_Dept_ID')} = $1 AND ${qi('Dept_Role_ID')} = $2
         AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [sevaDeptId, deptRoleId]
    );

    await client.query(
      `INSERT INTO ${qi('RMS')}.${qi('Seva_Dept_Role_HRCHY')}
        (${qi('Seva_Dept_ID')}, ${qi('Dept_Role_ID')}, ${qi('HRCHY_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, $3, CURRENT_DATE, $4)`,
      [sevaDeptId, deptRoleId, hrchyId, FAR_FUTURE]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /admin/hierarchy] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
