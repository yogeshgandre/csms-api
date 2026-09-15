// routes/master.js — lookup tables. Small, cacheable client-side; the
// front end should fetch these once per session, not per render.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/countries', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('Country_ID')}, ${qi('Region_ID')}, ${qi('Country_Name')}, ${qi('Country_ISD')},
              ${qi('Is_EU_UNION')}, ${qi('Report_Language')}
       FROM Master.${qi('M_Country')} ORDER BY ${qi('Country_Name')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/countries] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.get('/regions', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('Region_ID')}, ${qi('Region_Name')} FROM Master.${qi('M_Region')}
       WHERE ${qi('Ver_To_DT')} IS NULL ORDER BY ${qi('Region_Name')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/regions] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.get('/categories', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('Category_ID')}, ${qi('Category_Name')}, ${qi('Category_Desc')}
       FROM Master.${qi('M_Seeker_Category')} WHERE ${qi('Ver_To_DT')} IS NULL ORDER BY ${qi('Category_Name')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/categories] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.get('/platforms', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('Platform_ID')}, ${qi('Platform_Name')}, ${qi('Is_Form')}
       FROM Master.${qi('M_Platform')} ORDER BY ${qi('Platform_Name')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/platforms] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
