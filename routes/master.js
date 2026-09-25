// routes/master.js — lookup tables. Small, cacheable client-side; the
// front end should fetch these once per session, not per render.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// Real, computed KPIs for the Dashboard tab. No invented funnel stages or
// "days since contact" flags here — the schema has no generic contact-log
// concept, so this sticks to what's genuinely tracked: seeker counts,
// category spread, seva hours, skills, milestones, and who has no
// category yet (a real, actionable data-quality signal).
router.get('/dashboard-stats', requireAuth, async (_req, res) => {
  try {
    const statsQ = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM ${qi('MSR')}.${qi('Seeker')}) AS total_seekers,
        (SELECT COUNT(*) FROM ${qi('MSR')}.${qi('Seeker')} WHERE ${qi('Creation_DT')} >= now() - interval '30 days') AS new_this_month,
        (SELECT COALESCE(SUM(${qi('Weekly_Seva_Hrs')}),0) FROM ${qi('MSR')}.${qi('Seeker_Other_MasterList_Info')} WHERE ${qi('Ver_To_DT')} >= CURRENT_DATE) AS total_seva_hrs,
        (SELECT COUNT(DISTINCT ${qi('Skill_ID')}) FROM ${qi('MSR')}.${qi('Seeker_Skills')}) AS distinct_skills,
        (SELECT COUNT(*) FROM ${qi('MSR')}.${qi('Seeker_Milestone')} WHERE ${qi('Creation_DT')} >= now() - interval '30 days') AS milestones_this_month,
        (SELECT COUNT(*) FROM ${qi('MSR')}.${qi('Seeker')} s WHERE NOT EXISTS (
           SELECT 1 FROM ${qi('MSR')}.${qi('Seeker_Category')} sc
           WHERE sc.${qi('Seeker_ID')} = s.${qi('Seeker_ID')} AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE
         )) AS uncategorised
    `);
    const categoryQ = await pool.query(`
      SELECT cat.${qi('Category_Name')}, COUNT(*) AS n
      FROM ${qi('MSR')}.${qi('Seeker_Category')} sc
      JOIN ${qi('Master')}.${qi('M_Seeker_Category')} cat ON cat.${qi('Category_ID')} = sc.${qi('Seeker_Category_ID')}
      WHERE sc.${qi('Ver_To_DT')} >= CURRENT_DATE
      GROUP BY cat.${qi('Category_Name')}
      ORDER BY n DESC
    `);
    const recentQ = await pool.query(`
      SELECT ${qi('Seeker_ID')}, ${qi('Sal')}, ${qi('First_Name')}, ${qi('Last_Name')}, ${qi('City')}, ${qi('Creation_DT')}
      FROM ${qi('MSR')}.${qi('Seeker')} ORDER BY ${qi('Creation_DT')} DESC LIMIT 8
    `);
    const uncatQ = await pool.query(`
      SELECT s.${qi('Seeker_ID')}, s.${qi('Sal')}, s.${qi('First_Name')}, s.${qi('Last_Name')}, s.${qi('City')}
      FROM ${qi('MSR')}.${qi('Seeker')} s WHERE NOT EXISTS (
        SELECT 1 FROM ${qi('MSR')}.${qi('Seeker_Category')} sc
        WHERE sc.${qi('Seeker_ID')} = s.${qi('Seeker_ID')} AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE
      ) ORDER BY s.${qi('Creation_DT')} DESC LIMIT 8
    `);
    res.json({
      stats: statsQ.rows[0],
      byCategory: categoryQ.rows,
      recentSeekers: recentQ.rows,
      uncategorisedSeekers: uncatQ.rows,
    });
  } catch (err) {
    console.error('[GET /master/dashboard-stats] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.get('/countries', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('Country_ID')}, ${qi('Region_ID')}, ${qi('Country_Name')}, ${qi('Country_ISD')},
              ${qi('Is_EU_UNION')}, ${qi('Report_Language')}
       FROM ${qi('Master')}.${qi('M_Country')} ORDER BY ${qi('Country_Name')}`
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
      `SELECT ${qi('Region_ID')}, ${qi('Region_Name')} FROM ${qi('Master')}.${qi('M_Region')}
       WHERE ${qi('Ver_To_DT')} >= CURRENT_DATE ORDER BY ${qi('Region_Name')}`
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
       FROM ${qi('Master')}.${qi('M_Seeker_Category')} WHERE ${qi('Ver_To_DT')} >= CURRENT_DATE ORDER BY ${qi('Category_Name')}`
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
       FROM ${qi('Master')}.${qi('M_Platform')} ORDER BY ${qi('Platform_Name')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/platforms] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Skills (SMS.Skills) ============ */

router.get('/skills', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(`SELECT ${qi('Skill_ID')}, ${qi('Skill_Name')} FROM ${qi('SMS')}.${qi('Skills')} ORDER BY ${qi('Skill_Name')}`);
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/skills] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/skills', requireAuth, async (req, res) => {
  const { skillName } = req.body || {};
  if (!skillName) return res.status(400).json({ error: 'skillName is required' });
  try {
    const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('Skill_ID')}), 0) + 1 AS next_id FROM ${qi('SMS')}.${qi('Skills')}`);
    const id = maxQ.rows[0].next_id;
    await pool.query(`INSERT INTO ${qi('SMS')}.${qi('Skills')} (${qi('Skill_ID')}, ${qi('Skill_Name')}) VALUES ($1,$2)`, [id, skillName]);
    res.status(201).json({ ok: true, skillId: id });
  } catch (err) {
    console.error('[POST /master/skills] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

// GET /skills/:id/seekers — who has this skill, and at what level. This is
// what Seva Management's real (non-mock) skill search actually calls.
router.get('/skills/:id/seekers', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sk.${qi('Seeker_ID')}, seek.${qi('First_Name')}, seek.${qi('Last_Name')}, seek.${qi('Email')}, sk.${qi('Skill_Proficiency')}
       FROM ${qi('MSR')}.${qi('Seeker_Skills')} sk
       LEFT JOIN ${qi('MSR')}.${qi('Seeker')} seek ON seek.${qi('Seeker_ID')} = sk.${qi('Seeker_ID')}
       WHERE sk.${qi('Skill_ID')} = $1
       ORDER BY CASE sk.${qi('Skill_Proficiency')} WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, seek.${qi('First_Name')}`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/skills/:id/seekers] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Tickers (Master.M_Ticker) ============
   No versioning columns on this table (unlike most of this schema) — a
   ticker is either Is_Active or it isn't, and Start_DT/End_DT (if set)
   bound when it shows. Deleting one is a real DELETE, not a soft-close. */

router.get('/tickers', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM ${qi('Master')}.${qi('M_Ticker')} ORDER BY ${qi('Display_Order')} NULLS LAST, ${qi('Priority')} DESC NULLS LAST, ${qi('Ticker_ID')} DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/tickers] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /tickers/active — what the global marquee banner actually shows:
// Is_Active, and within its Start_DT/End_DT window if either is set.
router.get('/tickers/active', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('Ticker_ID')}, ${qi('Ticker_Text')}, ${qi('Ticker_Type')}
       FROM ${qi('Master')}.${qi('M_Ticker')}
       WHERE ${qi('Is_Active')} = true
         AND (${qi('Start_DT')} IS NULL OR ${qi('Start_DT')} <= now())
         AND (${qi('End_DT')} IS NULL OR ${qi('End_DT')} >= now())
       ORDER BY ${qi('Display_Order')} NULLS LAST, ${qi('Priority')} DESC NULLS LAST, ${qi('Ticker_ID')} DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /master/tickers/active] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/tickers', requireAuth, async (req, res) => {
  const { tickerText, tickerType, priority, startDt, endDt, isActive, displayOrder } = req.body || {};
  if (!tickerText || !['Alert', 'Warning', 'Information'].includes(tickerType)) {
    return res.status(400).json({ error: 'tickerText and a valid tickerType (Alert/Warning/Information) are required' });
  }
  try {
    const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('Ticker_ID')}), 0) + 1 AS next_id FROM ${qi('Master')}.${qi('M_Ticker')}`);
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('Master')}.${qi('M_Ticker')}
        (${qi('Ticker_ID')}, ${qi('Ticker_Text')}, ${qi('Ticker_Type')}, ${qi('Priority')}, ${qi('Start_DT')}, ${qi('End_DT')},
         ${qi('Is_Active')}, ${qi('Display_Order')}, ${qi('Created_ID')}, ${qi('Creation_DT')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      [id, tickerText, tickerType, priority || null, startDt || null, endDt || null, isActive !== false, displayOrder || null, req.user.csmsId]
    );
    res.status(201).json({ ok: true, tickerId: id });
  } catch (err) {
    console.error('[POST /master/tickers] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.put('/tickers/:id', requireAuth, async (req, res) => {
  const { tickerText, tickerType, priority, startDt, endDt, isActive, displayOrder } = req.body || {};
  if (!tickerText || !['Alert', 'Warning', 'Information'].includes(tickerType)) {
    return res.status(400).json({ error: 'tickerText and a valid tickerType (Alert/Warning/Information) are required' });
  }
  try {
    await pool.query(
      `UPDATE ${qi('Master')}.${qi('M_Ticker')}
       SET ${qi('Ticker_Text')} = $2, ${qi('Ticker_Type')} = $3, ${qi('Priority')} = $4, ${qi('Start_DT')} = $5,
           ${qi('End_DT')} = $6, ${qi('Is_Active')} = $7, ${qi('Display_Order')} = $8
       WHERE ${qi('Ticker_ID')} = $1`,
      [req.params.id, tickerText, tickerType, priority || null, startDt || null, endDt || null, isActive !== false, displayOrder || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /master/tickers/:id] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.delete('/tickers/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM ${qi('Master')}.${qi('M_Ticker')} WHERE ${qi('Ticker_ID')} = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /master/tickers/:id] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
