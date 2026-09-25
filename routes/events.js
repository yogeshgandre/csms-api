// routes/events.js — Events (retreats, workshops, introductory talks,
// online sessions): distinct from Satsangs (recurring group meetings).
// Mirrors SCS.Satsang_Conductor / Satsang_Attending_Seekers with
// SCS.Event_Conductor / Event_Registration so the Event Conductor
// dashboard has genuine data to scope to.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const EVENT_TYPES = ['Retreat', 'Workshop', 'Introductory Talk', 'Online'];

router.get('/', requireAuth, async (req, res) => {
  try {
    const mine = req.query.conductor === 'me';
    const params = [];
    let join = '';
    let where = '';
    if (mine) {
      join = `JOIN ${qi('SCS')}.${qi('Event_Conductor')} ec ON ec.${qi('Event_ID')} = e.${qi('Event_ID')} AND ec.${qi('Ver_To_DT')} >= CURRENT_DATE`;
      where = `WHERE ec.${qi('EC_CSMS_ID')} = $1`;
      params.push(req.user.csmsId);
    }
    const r = await pool.query(
      `SELECT e.${qi('Event_ID')}, e.${qi('Event_Name')}, e.${qi('Event_Type')}, e.${qi('Event_ST_DT_TIME')},
              e.${qi('Event_Duration')}, e.${qi('Venue_City')}, e.${qi('Event_Status')},
              COALESCE(reg.n, 0) AS registration_count
       FROM ${qi('SCS')}.${qi('M_Event')} e
       ${join}
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS n FROM ${qi('SCS')}.${qi('Event_Registration')} er
         WHERE er.${qi('Event_ID')} = e.${qi('Event_ID')} AND er.${qi('Ver_To_DT')} >= CURRENT_DATE
       ) reg ON true
       ${where}
       ORDER BY e.${qi('Event_ST_DT_TIME')} DESC`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /events] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const { eventName, eventType, startDateTime, durationMinutes, venueCity } = req.body || {};
  if (!eventName || !startDateTime) return res.status(400).json({ error: 'eventName and startDateTime are required' });
  const type = EVENT_TYPES.includes(eventType) ? eventType : 'Workshop';
  try {
    const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('Event_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('M_Event')}`);
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('M_Event')}
        (${qi('Event_ID')}, ${qi('Event_Name')}, ${qi('Event_Type')}, ${qi('Event_ST_DT_TIME')}, ${qi('Event_Duration')}, ${qi('Venue_City')}, ${qi('Created_ID')})
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, eventName, type, startDateTime, durationMinutes || null, venueCity || null, req.user.csmsId]
    );
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('Event_Conductor')} (${qi('Event_ID')}, ${qi('EC_CSMS_ID')}, ${qi('Created_ID')})
       VALUES ($1,$2,$3)`,
      [id, req.user.csmsId, req.user.csmsId]
    );
    res.status(201).json({ ok: true, eventId: id });
  } catch (err) {
    console.error('[POST /events] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  const { eventStatus } = req.body || {};
  if (!['Scheduled', 'Completed', 'Cancelled'].includes(eventStatus)) return res.status(400).json({ error: 'invalid status' });
  try {
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('M_Event')} SET ${qi('Event_Status')} = $1 WHERE ${qi('Event_ID')} = $2`,
      [eventStatus, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /events/:id] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.get('/:id/registrations', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT er.${qi('Seeker_ID')}, er.${qi('Attended')}, er.${qi('Is_First_Time')}, er.${qi('Registration_DT')},
              s.${qi('Sal')}, s.${qi('First_Name')}, s.${qi('Last_Name')}, s.${qi('Email')}
       FROM ${qi('SCS')}.${qi('Event_Registration')} er
       JOIN ${qi('MSR')}.${qi('Seeker')} s ON s.${qi('Seeker_ID')} = er.${qi('Seeker_ID')}
       WHERE er.${qi('Event_ID')} = $1 AND er.${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY er.${qi('Registration_DT')} DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /events/:id/registrations] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.post('/:id/registrations', requireAuth, async (req, res) => {
  const { seekerId } = req.body || {};
  if (!seekerId) return res.status(400).json({ error: 'seekerId is required' });
  try {
    // "First-timer" here means: no prior event registration anywhere,
    // not just for this event — computed from real history, not asked.
    const priorQ = await pool.query(
      `SELECT 1 FROM ${qi('SCS')}.${qi('Event_Registration')} WHERE ${qi('Seeker_ID')} = $1 LIMIT 1`,
      [seekerId]
    );
    const isFirstTime = priorQ.rows.length === 0;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('Event_Registration')} (${qi('Event_ID')}, ${qi('Seeker_ID')}, ${qi('Is_First_Time')}, ${qi('Created_ID')})
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (${qi('Event_ID')}, ${qi('Seeker_ID')}, ${qi('Ver_From_DT')}) DO NOTHING`,
      [req.params.id, seekerId, isFirstTime, req.user.csmsId]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[POST /events/:id/registrations] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.put('/:id/registrations/:seekerId', requireAuth, async (req, res) => {
  const { attended } = req.body || {};
  if (!['Yes', 'No', 'Pending'].includes(attended)) return res.status(400).json({ error: 'invalid attended value' });
  try {
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('Event_Registration')} SET ${qi('Attended')} = $1
       WHERE ${qi('Event_ID')} = $2 AND ${qi('Seeker_ID')} = $3 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [attended, req.params.id, req.params.seekerId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /events/:id/registrations/:seekerId] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

module.exports = router;
