// routes/master.js — lookup tables. Small, cacheable client-side; the
// front end should fetch these once per session, not per render.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// Scoped to the satsangs the logged-in user actually conducts
// (SCS.Satsang_Conductor) — real, not simulated regional/role masking.
async function satsangConductorStats(csmsId) {
  const mySatsangsQ = await pool.query(
    `SELECT ms.${qi('Satsang_ID')}, ms.${qi('Satsang_Name')}
     FROM ${qi('SCS')}.${qi('Satsang_Conductor')} sc
     JOIN ${qi('SCS')}.${qi('M_Satsang')} ms ON ms.${qi('Satsang_ID')} = sc.${qi('Satsang_ID')}
     WHERE sc.${qi('SC_CSMS_ID')} = $1 AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE`,
    [csmsId]
  );
  const ids = mySatsangsQ.rows.map(r => r.Satsang_ID);
  if (!ids.length) {
    return { view: 'satsang', mySatsangs: [], stats: { attending_seekers: 0, sessions_this_month: 0, completed_sessions: 0 }, byCategory: [], recentSeekers: [] };
  }
  const statsQ = await pool.query(`
    SELECT
      (SELECT COUNT(DISTINCT ${qi('Seeker_ID')}) FROM ${qi('SCS')}.${qi('Satsang_Attending_Seekers')}
         WHERE ${qi('Satsang_ID')} = ANY($1::bigint[]) AND ${qi('Ver_To_DT')} >= CURRENT_DATE) AS attending_seekers,
      (SELECT COUNT(*) FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')}
         WHERE ${qi('Satsang_ID')} = ANY($1::bigint[]) AND ${qi('Event_ST_DT_TIME')} >= now() - interval '30 days') AS sessions_this_month,
      (SELECT COUNT(*) FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} sed
         JOIN ${qi('SCS')}.${qi('Satsang_Event_Status')} ses ON ses.${qi('SE_ID')} = sed.${qi('SE_ID')}
         WHERE sed.${qi('Satsang_ID')} = ANY($1::bigint[]) AND ses.${qi('Current_Status')} = 'Completed'
           AND ses.${qi('Ver_To_DT')} >= CURRENT_DATE) AS completed_sessions
  `, [ids]);
  const categoryQ = await pool.query(`
    SELECT cat.${qi('Category_Name')}, COUNT(DISTINCT sas.${qi('Seeker_ID')}) AS n
    FROM ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} sas
    JOIN ${qi('MSR')}.${qi('Seeker_Category')} sc ON sc.${qi('Seeker_ID')} = sas.${qi('Seeker_ID')} AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE
    JOIN ${qi('Master')}.${qi('M_Seeker_Category')} cat ON cat.${qi('Category_ID')} = sc.${qi('Seeker_Category_ID')}
    WHERE sas.${qi('Satsang_ID')} = ANY($1::bigint[]) AND sas.${qi('Ver_To_DT')} >= CURRENT_DATE
    GROUP BY cat.${qi('Category_Name')} ORDER BY n DESC
  `, [ids]);
  const recentQ = await pool.query(`
    SELECT DISTINCT s.${qi('Seeker_ID')}, s.${qi('Sal')}, s.${qi('First_Name')}, s.${qi('Last_Name')}, s.${qi('City')}
    FROM ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} sas
    JOIN ${qi('MSR')}.${qi('Seeker')} s ON s.${qi('Seeker_ID')} = sas.${qi('Seeker_ID')}
    WHERE sas.${qi('Satsang_ID')} = ANY($1::bigint[]) AND sas.${qi('Ver_To_DT')} >= CURRENT_DATE
    ORDER BY s.${qi('Seeker_ID')} DESC LIMIT 8
  `, [ids]);
  return {
    view: 'satsang',
    mySatsangs: mySatsangsQ.rows,
    stats: statsQ.rows[0],
    byCategory: categoryQ.rows,
    recentSeekers: recentQ.rows,
  };
}

// Scoped to the events the logged-in user actually conducts
// (SCS.Event_Conductor) — real, not simulated.
async function eventConductorStats(csmsId) {
  const myEventsQ = await pool.query(
    `SELECT e.${qi('Event_ID')}, e.${qi('Event_Name')}, e.${qi('Event_Type')}, e.${qi('Event_ST_DT_TIME')}, e.${qi('Event_Status')}
     FROM ${qi('SCS')}.${qi('Event_Conductor')} ec
     JOIN ${qi('SCS')}.${qi('M_Event')} e ON e.${qi('Event_ID')} = ec.${qi('Event_ID')}
     WHERE ec.${qi('EC_CSMS_ID')} = $1 AND ec.${qi('Ver_To_DT')} >= CURRENT_DATE
     ORDER BY e.${qi('Event_ST_DT_TIME')} DESC`,
    [csmsId]
  );
  const ids = myEventsQ.rows.map(r => r.Event_ID);
  if (!ids.length) {
    return { view: 'event', myEvents: [], stats: { total_registrations: 0, attended: 0, first_timers: 0, follow_up_pending: 0 }, recentRegistrations: [] };
  }
  const statsQ = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM ${qi('SCS')}.${qi('Event_Registration')}
         WHERE ${qi('Event_ID')} = ANY($1::bigint[]) AND ${qi('Ver_To_DT')} >= CURRENT_DATE) AS total_registrations,
      (SELECT COUNT(*) FROM ${qi('SCS')}.${qi('Event_Registration')}
         WHERE ${qi('Event_ID')} = ANY($1::bigint[]) AND ${qi('Attended')} = 'Yes' AND ${qi('Ver_To_DT')} >= CURRENT_DATE) AS attended,
      (SELECT COUNT(*) FROM ${qi('SCS')}.${qi('Event_Registration')}
         WHERE ${qi('Event_ID')} = ANY($1::bigint[]) AND ${qi('Is_First_Time')} = true AND ${qi('Ver_To_DT')} >= CURRENT_DATE) AS first_timers,
      (SELECT COUNT(*) FROM ${qi('SCS')}.${qi('Event_Registration')}
         WHERE ${qi('Event_ID')} = ANY($1::bigint[]) AND ${qi('Attended')} = 'Yes' AND ${qi('Is_First_Time')} = true
           AND ${qi('Ver_To_DT')} >= CURRENT_DATE) AS first_timers_attended
  `, [ids]);
  const recentQ = await pool.query(`
    SELECT er.${qi('Event_ID')}, er.${qi('Attended')}, er.${qi('Is_First_Time')}, er.${qi('Registration_DT')},
           s.${qi('Seeker_ID')}, s.${qi('Sal')}, s.${qi('First_Name')}, s.${qi('Last_Name')}
    FROM ${qi('SCS')}.${qi('Event_Registration')} er
    JOIN ${qi('MSR')}.${qi('Seeker')} s ON s.${qi('Seeker_ID')} = er.${qi('Seeker_ID')}
    WHERE er.${qi('Event_ID')} = ANY($1::bigint[]) AND er.${qi('Ver_To_DT')} >= CURRENT_DATE
    ORDER BY er.${qi('Registration_DT')} DESC LIMIT 8
  `, [ids]);
  return {
    view: 'event',
    myEvents: myEventsQ.rows,
    stats: statsQ.rows[0],
    recentRegistrations: recentQ.rows,
  };
}

// Real, computed KPIs for the Dashboard tab. No invented funnel stages or
// "days since contact" flags here — the schema has no generic contact-log
// concept, so this sticks to what's genuinely tracked.
//
// ?view=admin|rs|satsang|event (default admin)
//   admin/rs: seeker counts, categories, seva hours, skills, milestones —
//     rs additionally scoped to ?regions=Country1,Country2 (Country_Name)
//   satsang: scoped to satsangs the logged-in user conducts
//   event:   scoped to events the logged-in user conducts
router.get('/dashboard-stats', requireAuth, async (req, res) => {
  const view = ['admin', 'rs', 'satsang', 'event'].includes(req.query.view) ? req.query.view : 'admin';
  try {
    if (view === 'satsang') return res.json(await satsangConductorStats(req.user.csmsId));
    if (view === 'event') return res.json(await eventConductorStats(req.user.csmsId));

    const regions = (req.query.regions || '').split(',').map(r => r.trim()).filter(Boolean);
    const regionFilter = (view === 'rs' && regions.length)
      ? `AND c.${qi('Country_Name')} = ANY($1::text[])` : '';
    const regionParams = (view === 'rs' && regions.length) ? [regions] : [];

    const statsQ = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM ${qi('MSR')}.${qi('Seeker')} s LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')} WHERE true ${regionFilter}) AS total_seekers,
        (SELECT COUNT(*) FROM ${qi('MSR')}.${qi('Seeker')} s LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')} WHERE s.${qi('Creation_DT')} >= now() - interval '30 days' ${regionFilter}) AS new_this_month,
        (SELECT COALESCE(SUM(ml.${qi('Weekly_Seva_Hrs')}),0) FROM ${qi('MSR')}.${qi('Seeker_Other_MasterList_Info')} ml
           JOIN ${qi('MSR')}.${qi('Seeker')} s ON s.${qi('Seeker_ID')} = ml.${qi('Seeker_ID')}
           LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')}
           WHERE ml.${qi('Ver_To_DT')} >= CURRENT_DATE ${regionFilter}) AS total_seva_hrs,
        (SELECT COUNT(DISTINCT sk.${qi('Skill_ID')}) FROM ${qi('MSR')}.${qi('Seeker_Skills')} sk
           JOIN ${qi('MSR')}.${qi('Seeker')} s ON s.${qi('Seeker_ID')} = sk.${qi('Seeker_ID')}
           LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')}
           WHERE true ${regionFilter}) AS distinct_skills,
        (SELECT COUNT(*) FROM ${qi('MSR')}.${qi('Seeker_Milestone')} sm
           JOIN ${qi('MSR')}.${qi('Seeker')} s ON s.${qi('Seeker_ID')} = sm.${qi('Seeker_ID')}
           LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')}
           WHERE sm.${qi('Creation_DT')} >= now() - interval '30 days' ${regionFilter}) AS milestones_this_month,
        (SELECT COUNT(*) FROM ${qi('MSR')}.${qi('Seeker')} s
           LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')}
           WHERE NOT EXISTS (
             SELECT 1 FROM ${qi('MSR')}.${qi('Seeker_Category')} sc
             WHERE sc.${qi('Seeker_ID')} = s.${qi('Seeker_ID')} AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE
           ) ${regionFilter}) AS uncategorised
    `, regionParams);

    const categoryQ = await pool.query(`
      SELECT cat.${qi('Category_Name')}, COUNT(*) AS n
      FROM ${qi('MSR')}.${qi('Seeker_Category')} sc
      JOIN ${qi('Master')}.${qi('M_Seeker_Category')} cat ON cat.${qi('Category_ID')} = sc.${qi('Seeker_Category_ID')}
      JOIN ${qi('MSR')}.${qi('Seeker')} s ON s.${qi('Seeker_ID')} = sc.${qi('Seeker_ID')}
      LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')}
      WHERE sc.${qi('Ver_To_DT')} >= CURRENT_DATE ${regionFilter}
      GROUP BY cat.${qi('Category_Name')}
      ORDER BY n DESC
    `, regionParams);

    const recentQ = await pool.query(`
      SELECT s.${qi('Seeker_ID')}, s.${qi('Sal')}, s.${qi('First_Name')}, s.${qi('Last_Name')}, s.${qi('City')}, s.${qi('Creation_DT')}
      FROM ${qi('MSR')}.${qi('Seeker')} s
      LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')}
      WHERE true ${regionFilter} ORDER BY s.${qi('Creation_DT')} DESC LIMIT 8
    `, regionParams);

    const uncatQ = await pool.query(`
      SELECT s.${qi('Seeker_ID')}, s.${qi('Sal')}, s.${qi('First_Name')}, s.${qi('Last_Name')}, s.${qi('City')}
      FROM ${qi('MSR')}.${qi('Seeker')} s
      LEFT JOIN ${qi('Master')}.${qi('M_Country')} c ON c.${qi('Country_ID')} = s.${qi('Country_ID')}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${qi('MSR')}.${qi('Seeker_Category')} sc
        WHERE sc.${qi('Seeker_ID')} = s.${qi('Seeker_ID')} AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE
      ) ${regionFilter} ORDER BY s.${qi('Creation_DT')} DESC LIMIT 8
    `, regionParams);

    res.json({
      view,
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
