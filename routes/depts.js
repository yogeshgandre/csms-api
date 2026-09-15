// routes/depts.js — Seva_Dept tree + roles, for the Team tab.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const depts = await pool.query(
      `SELECT ${qi('Seva_Dept_ID')}, ${qi('Seva_Dept_Name')}, ${qi('Parent_Seva_Dept_ID')}
       FROM RMS.${qi('Seva_Dept')}
       WHERE ${qi('Ver_To_DT')} IS NULL
       ORDER BY ${qi('Seva_Dept_Name')}`
    );
    res.json(depts.rows);
  } catch (err) {
    console.error('[GET /depts] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/depts/:id/roles — Seva_Dept_Role + who holds them (User_Seva_Dept_Role)
router.get('/:id/roles', requireAuth, async (req, res) => {
  try {
    const roles = await pool.query(
      `SELECT r.${qi('Dept_Role_ID')}, r.${qi('Dept_Role_Name')}, r.${qi('Dept_Role_Desc')},
              up.${qi('CSMS_ID')}, up.${qi('Seeker_Name')}
       FROM RMS.${qi('Seva_Dept_Role')} r
       LEFT JOIN RMS.${qi('User_Seva_Dept_Role')} usdr
         ON usdr.${qi('Dept_Role_ID')} = r.${qi('Dept_Role_ID')} AND usdr.${qi('Ver_To_DT')} IS NULL
       LEFT JOIN RMS.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = usdr.${qi('CSMS_ID')}
       WHERE r.${qi('Seva_Dept_ID')} = $1 AND r.${qi('Ver_To_DT')} IS NULL`,
      [req.params.id]
    );
    res.json(roles.rows);
  } catch (err) {
    console.error('[GET /depts/:id/roles] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
