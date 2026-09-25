// routes/satsangs.js — Satsang Management: definitions (with review/approve
// workflow), dynamic per-satsang fields, conductor roster, attending
// seekers, and events (blocked until the definition is Approved, and each
// event itself needs a conductor's approval before it counts as Scheduled).
//
// NOTE: Event_ST_DT_TIME is being migrated to TIMESTAMPTZ (was bigint unix
// seconds) — the /upcoming query below already assumes the new type.
//
// NOTE: Satsang_Conductor has no surrogate PK — just (Satsang_ID,
// SC_CSMS_ID) — so its rows are addressed by that pair rather than a
// single id. Satsang_Attending_Seekers is the same shape, now keyed on
// (Satsang_ID, Seeker_ID) after the AS_CSMS_ID -> Seeker_ID rename below.
//
// NOTE: Attendees were originally modeled via AS_CSMS_ID (RMS.User_Profile
// identity, same as staff) — corrected to Seeker_ID (real MSR.Seeker) per
// instruction. Attendee_Transfer_Requests.AS_CSMS_ID was renamed to
// Seeker_ID too (confirmed run) — code below now matches.

const express = require('express');
const crypto = require('crypto');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const FAR_FUTURE = '9999-12-31';

// Shared with admin.js's assign-role logic (duplicated rather than shared
// across files for now — worth extracting if a third copy shows up).
// Finds a User_Profile by email, or creates one (MAX+1 CSMS_ID, no
// Ver_From_DT/Ver_To_DT on this table — confirmed by testing).
async function findOrCreateProfile(client, email, name) {
  const existing = await client.query(
    `SELECT ${qi('CSMS_ID')}, ${qi('Seeker_Name')} FROM ${qi('RMS')}.${qi('User_Profile')}
     WHERE lower(${qi('Seeker_Email')}) = lower($1) LIMIT 1`,
    [email]
  );
  if (existing.rowCount > 0) {
    return { csmsId: existing.rows[0].CSMS_ID, name: existing.rows[0].Seeker_Name, created: false };
  }
  const maxQ = await client.query(
    `SELECT COALESCE(MAX(${qi('CSMS_ID')}), 0) + 1 AS next_id FROM ${qi('RMS')}.${qi('User_Profile')}`
  );
  const csmsId = maxQ.rows[0].next_id;
  const personName = (name && name.trim()) || email.split('@')[0];
  const insQ = await client.query(
    `INSERT INTO ${qi('RMS')}.${qi('User_Profile')} (${qi('CSMS_ID')}, ${qi('Seeker_Email')}, ${qi('Seeker_Name')})
     VALUES ($1, $2, $3) RETURNING ${qi('CSMS_ID')}`,
    [csmsId, email, personName]
  );
  return { csmsId: insQ.rows[0].CSMS_ID, name: personName, created: true };
}

// Best-effort in-app notification — never throws into the caller, since a
// failed notification shouldn't roll back the actual workflow action.
async function notify(client, csmsId, message, linkKind, linkId) {
  try {
    const maxQ = await client.query(
      `SELECT COALESCE(MAX(${qi('Notification_ID')}), 0) + 1 AS next_id FROM ${qi('RMS')}.${qi('Notification')}`
    );
    await client.query(
      `INSERT INTO ${qi('RMS')}.${qi('Notification')}
        (${qi('Notification_ID')}, ${qi('CSMS_ID')}, ${qi('Message')}, ${qi('Link_Kind')}, ${qi('Link_ID')})
       VALUES ($1, $2, $3, $4, $5)`,
      [maxQ.rows[0].next_id, csmsId, message, linkKind, linkId]
    );
  } catch (err) {
    console.error('[notify] non-fatal, could not write notification', err.message);
  }
}

/* ============ Satsang Definitions ============ */

router.get('/types', requireAuth, async (req, res) => {
  try {
    // SS_Desc and Active_Flag were both in the original query but don't exist
    // on M_Satsang_type in the real schema — removed rather than guessed at
    // again, since nothing else in this file reads them (the two JOINs on
    // this table below only use ST_Name). Dropping the WHERE clause means
    // this now returns every satsang type, active or not, which is the safe
    // fallback until the real "active" column name (if one exists) is
    // confirmed against the schema and the filter is added back.
    const r = await pool.query(
      `SELECT ${qi('Satsang_Type_ID')}, ${qi('ST_Name')}
       FROM ${qi('SCS')}.${qi('M_Satsang_type')} ORDER BY ${qi('ST_Name')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/types] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.get('/defs', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ms.${qi('Satsang_ID')}, ms.${qi('Satsang_Short_Name')}, ms.${qi('Satsang_Name')},
              ms.${qi('Satsang_Type_ID')}, mt.${qi('ST_Name')},
              ms.${qi('Satsang_Start_Date')}, ms.${qi('Satsang_Frequency')},
              ms.${qi('Satsang_Status')}, ms.${qi('Created_By_CSMS_ID')},
              up.${qi('Seeker_Name')} AS created_by_name
       FROM ${qi('SCS')}.${qi('M_Satsang')} ms
       LEFT JOIN ${qi('SCS')}.${qi('M_Satsang_type')} mt ON mt.${qi('Satsang_Type_ID')} = ms.${qi('Satsang_Type_ID')}
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = ms.${qi('Created_By_CSMS_ID')}
       WHERE ms.${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY ms.${qi('Satsang_Name')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/defs] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// NOTE: advNotification is accepted from the client but not yet persisted —
// the real column name for "days advance notification" on M_Satsang isn't
// confirmed (Satsang_Adv_Notification doesn't exist as written). Add it
// back to the SELECT/INSERT/UPDATE below once the exact name is known.
router.post('/defs', requireAuth, async (req, res) => {
  const { shortName, name, typeId, startDate, frequency } = req.body || {};
  if (!shortName || !name || !typeId || !startDate) {
    return res.status(400).json({ error: 'shortName, name, typeId and startDate are required' });
  }
  try {
    const maxQ = await pool.query(
      `SELECT COALESCE(MAX(${qi('Satsang_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('M_Satsang')}`
    );
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('M_Satsang')}
        (${qi('Satsang_ID')}, ${qi('Satsang_Type_ID')}, ${qi('Satsang_Short_Name')}, ${qi('Satsang_Name')},
         ${qi('Created_By_CSMS_ID')}, ${qi('Satsang_Start_Date')}, ${qi('Satsang_Frequency')},
         ${qi('Satsang_Status')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Draft',CURRENT_DATE,$8)`,
      [id, typeId, shortName, name, req.user.csmsId, startDate, frequency || null, FAR_FUTURE]
    );
    res.status(201).json({ ok: true, satsangId: id });
  } catch (err) {
    console.error('[POST /satsangs/defs] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.put('/defs/:id', requireAuth, async (req, res) => {
  const { shortName, name, typeId, startDate, frequency } = req.body || {};
  try {
    const cur = await pool.query(
      `SELECT ${qi('Satsang_Status')} FROM ${qi('SCS')}.${qi('M_Satsang')} WHERE ${qi('Satsang_ID')} = $1`,
      [req.params.id]
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!['Draft', 'Rejected'].includes(cur.rows[0].Satsang_Status)) {
      return res.status(409).json({ error: 'NOT_EDITABLE', message: 'Only Draft or Rejected definitions can be edited.' });
    }
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('M_Satsang')}
       SET ${qi('Satsang_Short_Name')}=$1, ${qi('Satsang_Name')}=$2, ${qi('Satsang_Type_ID')}=$3,
           ${qi('Satsang_Start_Date')}=$4, ${qi('Satsang_Frequency')}=$5
       WHERE ${qi('Satsang_ID')} = $6`,
      [shortName, name, typeId, startDate, frequency || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /satsangs/defs/:id] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

// Submit for review. Notifies whoever holds a role listed as a review role
// in Satsangs_Seva_Dept_Access (union across all active rows) — this is a
// simplification: it doesn't scope by which department "owns" this
// particular satsang, since nothing in the given schema links a Satsang to
// a department directly. Review and approve are also collapsed into one
// step for now (whoever can review can also approve/reject) rather than a
// separate two-stage handoff.
router.post('/defs/:id/submit', requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT ${qi('Satsang_Status')}, ${qi('Satsang_Name')} FROM ${qi('SCS')}.${qi('M_Satsang')} WHERE ${qi('Satsang_ID')} = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND' }); }
    if (!['Draft', 'Rejected'].includes(cur.rows[0].Satsang_Status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'BAD_STATE', message: 'Only a Draft or Rejected definition can be submitted for review.' });
    }
    await client.query(
      `UPDATE ${qi('SCS')}.${qi('M_Satsang')}
       SET ${qi('Satsang_Status')}='In Review', ${qi('Status_Changed_By_CSMS_ID')}=$1, ${qi('Status_Changed_DT')}=now()
       WHERE ${qi('Satsang_ID')} = $2`,
      [req.user.csmsId, req.params.id]
    );

    const reviewerRoleIdsQ = await client.query(
      `SELECT DISTINCT unnest(string_to_array(${qi('Satsang_Review_Role_ID')}, ',')) AS role_id
       FROM ${qi('SCS')}.${qi('Satsangs_Seva_Dept_Access')}
       WHERE ${qi('Ver_To_DT')} >= CURRENT_DATE AND ${qi('Satsang_Review_Role_ID')} IS NOT NULL`
    );
    const roleIds = reviewerRoleIdsQ.rows.map(r => r.role_id.trim()).filter(Boolean);
    if (roleIds.length) {
      const reviewersQ = await client.query(
        `SELECT DISTINCT ${qi('CSMS_ID')} FROM ${qi('RMS')}.${qi('User_Seva_Dept_Role')}
         WHERE ${qi('Seva_Dept_Role_ID')} = ANY($1::bigint[])
           AND (${qi('Ver_To_DT')} IS NULL OR ${qi('Ver_To_DT')} >= CURRENT_DATE)`,
        [roleIds]
      );
      for (const row of reviewersQ.rows) {
        await notify(client, row.CSMS_ID, `"${cur.rows[0].Satsang_Name}" was submitted for review.`, 'satsang_def', req.params.id);
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /satsangs/defs/:id/submit] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

router.post('/defs/:id/approve', requireAuth, async (req, res) => {
  await setDefStatus(req, res, 'Approved', (name) => `"${name}" was approved.`);
});
router.post('/defs/:id/reject', requireAuth, async (req, res) => {
  const remarks = (req.body || {}).remarks;
  await setDefStatus(req, res, 'Rejected', (name) => `"${name}" was rejected.${remarks ? ' ' + remarks : ''}`);
});

async function setDefStatus(req, res, newStatus, messageFor) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT ${qi('Satsang_Status')}, ${qi('Satsang_Name')}, ${qi('Created_By_CSMS_ID')}
       FROM ${qi('SCS')}.${qi('M_Satsang')} WHERE ${qi('Satsang_ID')} = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND' }); }
    if (cur.rows[0].Satsang_Status !== 'In Review') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'BAD_STATE', message: 'Only a definition currently In Review can be ' + newStatus.toLowerCase() + '.' });
    }
    await client.query(
      `UPDATE ${qi('SCS')}.${qi('M_Satsang')}
       SET ${qi('Satsang_Status')}=$1, ${qi('Status_Changed_By_CSMS_ID')}=$2, ${qi('Status_Changed_DT')}=now()
       WHERE ${qi('Satsang_ID')} = $3`,
      [newStatus, req.user.csmsId, req.params.id]
    );
    if (cur.rows[0].Created_By_CSMS_ID) {
      await notify(client, cur.rows[0].Created_By_CSMS_ID, messageFor(cur.rows[0].Satsang_Name), 'satsang_def', req.params.id);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[setDefStatus] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
}

router.delete('/defs/:id', requireAuth, async (req, res) => {
  try {
    const cur = await pool.query(
      `SELECT ${qi('Satsang_Status')} FROM ${qi('SCS')}.${qi('M_Satsang')} WHERE ${qi('Satsang_ID')} = $1`,
      [req.params.id]
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    if (cur.rows[0].Satsang_Status === 'Approved') {
      return res.status(409).json({ error: 'IS_APPROVED', message: 'An approved satsang definition cannot be deleted directly — check for events first.' });
    }
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('M_Satsang')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day' WHERE ${qi('Satsang_ID')} = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /satsangs/defs/:id] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Dynamic fields (M_Satsang_Defn) ============
   Review_Frequency ('One-time'|'Daily'|'Weekly') decides how often an
   attendee is expected to submit a value for that field on the public
   form — see routes/public-forms.js for how the period is worked out. */

router.get('/defs/:id/fields', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('MSD_ID')}, ${qi('Field_Name')}, ${qi('Field_Data_Type')}, ${qi('QLT_FIELD')}, ${qi('QTY_FIELD')}, ${qi('Display_Order')}, ${qi('Review_Frequency')}
       FROM ${qi('SCS')}.${qi('M_Satsang_Defn')}
       WHERE ${qi('Satsang_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY ${qi('Display_Order')} NULLS LAST, ${qi('Field_Name')}`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/defs/:id/fields] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/defs/:id/fields', requireAuth, async (req, res) => {
  const { fieldName, dataType, isQlt, isQty, displayOrder, reviewFrequency } = req.body || {};
  if (!fieldName) return res.status(400).json({ error: 'fieldName is required' });
  const freq = ['One-time', 'Daily', 'Weekly'].includes(reviewFrequency) ? reviewFrequency : 'One-time';
  try {
    const maxQ = await pool.query(
      `SELECT COALESCE(MAX(${qi('MSD_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('M_Satsang_Defn')}`
    );
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('M_Satsang_Defn')}
        (${qi('MSD_ID')}, ${qi('Satsang_ID')}, ${qi('Field_Name')}, ${qi('Field_Data_Type')}, ${qi('QLT_FIELD')}, ${qi('QTY_FIELD')}, ${qi('Display_Order')}, ${qi('Review_Frequency')}, ${qi('Ver_from_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE,$9)`,
      [id, req.params.id, fieldName, dataType || 'text', !!isQlt, !!isQty, displayOrder || null, freq, FAR_FUTURE]
    );
    res.status(201).json({ ok: true, fieldId: id });
  } catch (err) {
    console.error('[POST /satsangs/defs/:id/fields] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.delete('/fields/:msdId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('M_Satsang_Defn')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day' WHERE ${qi('MSD_ID')} = $1`,
      [req.params.msdId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /satsangs/fields/:msdId] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Conductor roster (Satsang_Conductor) ============
   No surrogate PK on this table — addressed by (Satsang_ID, SC_CSMS_ID). */

router.get('/defs/:id/conductors', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sc.${qi('SC_CSMS_ID')}, up.${qi('Seeker_Name')}, up.${qi('Seeker_Email')}
       FROM ${qi('SCS')}.${qi('Satsang_Conductor')} sc
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = sc.${qi('SC_CSMS_ID')}
       WHERE sc.${qi('Satsang_ID')} = $1 AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/defs/:id/conductors] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/defs/:id/conductors', requireAuth, async (req, res) => {
  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const profile = await findOrCreateProfile(client, email, name);
    await client.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Conductor')} (${qi('Satsang_ID')}, ${qi('SC_CSMS_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, CURRENT_DATE, $3)`,
      [req.params.id, profile.csmsId, FAR_FUTURE]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, name: profile.name, profileCreated: profile.created });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /satsangs/defs/:id/conductors] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

router.delete('/defs/:id/conductors/:csmsId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('Satsang_Conductor')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Satsang_ID')} = $1 AND ${qi('SC_CSMS_ID')} = $2`,
      [req.params.id, req.params.csmsId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /satsangs/defs/:id/conductors/:csmsId] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Attending seekers (Satsang_Attending_Seekers) ============
   Same no-surrogate-PK situation as conductors. Unlike conductors, attendees
   are now real MSR.Seeker people (Seeker_ID), not auto-provisioned CSMS
   profiles — a seeker must already exist (via the Intake flow) to be added
   here, so this takes a seekerId directly rather than an email to look up
   or create. */

router.get('/defs/:id/attendees', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sas.${qi('Seeker_ID')}, sas.${qi('Remarks')}, sk.${qi('First_Name')}, sk.${qi('Last_Name')}, sk.${qi('Email')}
       FROM ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} sas
       LEFT JOIN ${qi('MSR')}.${qi('Seeker')} sk ON sk.${qi('Seeker_ID')} = sas.${qi('Seeker_ID')}
       WHERE sas.${qi('Satsang_ID')} = $1 AND sas.${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/defs/:id/attendees] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/defs/:id/attendees', requireAuth, async (req, res) => {
  const { seekerId, remarks } = req.body || {};
  if (!seekerId) return res.status(400).json({ error: 'seekerId is required' });
  try {
    const skQ = await pool.query(`SELECT ${qi('Seeker_ID')} FROM ${qi('MSR')}.${qi('Seeker')} WHERE ${qi('Seeker_ID')} = $1`, [seekerId]);
    if (skQ.rowCount === 0) return res.status(404).json({ error: 'SEEKER_NOT_FOUND', message: 'No such seeker.' });
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Attending_Seekers')}
        (${qi('Satsang_ID')}, ${qi('Seeker_ID')}, ${qi('Remarks')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, $3, CURRENT_DATE, $4)`,
      [req.params.id, seekerId, remarks || null, FAR_FUTURE]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[POST /satsangs/defs/:id/attendees] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.delete('/defs/:id/attendees/:seekerId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Satsang_ID')} = $1 AND ${qi('Seeker_ID')} = $2`,
      [req.params.id, req.params.seekerId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /satsangs/defs/:id/attendees/:seekerId] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Events (Satsang_Event_Defn + Satsang_Event_Status) ============ */

router.get('/upcoming', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT se.${qi('SE_ID')}, se.${qi('Satsang_ID')}, se.${qi('Event_ST_DT_TIME')},
              se.${qi('Event_Time_City')}, se.${qi('Event_Duration')},
              ms.${qi('Satsang_Name')}, ms.${qi('Satsang_Short_Name')}, mt.${qi('ST_Name')},
              est.${qi('Current_Status')}, est.${qi('Event_Link')}
       FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} se
       JOIN ${qi('SCS')}.${qi('M_Satsang')} ms ON ms.${qi('Satsang_ID')} = se.${qi('Satsang_ID')}
       LEFT JOIN ${qi('SCS')}.${qi('M_Satsang_type')} mt ON mt.${qi('Satsang_Type_ID')} = ms.${qi('Satsang_Type_ID')}
       LEFT JOIN ${qi('SCS')}.${qi('Satsang_Event_Status')} est ON est.${qi('SE_ID')} = se.${qi('SE_ID')}
       WHERE se.${qi('Event_ST_DT_TIME')} >= NOW()
       ORDER BY se.${qi('Event_ST_DT_TIME')} ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /satsangs/upcoming] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.get('/defs/:id/events', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT se.${qi('SE_ID')}, se.${qi('Event_ST_DT_TIME')}, se.${qi('Event_Time_City')}, se.${qi('Event_Duration')},
              est.${qi('Current_Status')}, est.${qi('Event_Link')}, est.${qi('Current_Status_Change_Date')}
       FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} se
       LEFT JOIN ${qi('SCS')}.${qi('Satsang_Event_Status')} est ON est.${qi('SE_ID')} = se.${qi('SE_ID')}
       WHERE se.${qi('Satsang_ID')} = $1
       ORDER BY se.${qi('Event_ST_DT_TIME')} DESC`,
      [req.params.id]
    );
    // Conductors are no longer per-event columns — they live on
    // SCS.Satsang_Conductor, scoped to the whole satsang (Satsang_ID),
    // not per event. Attach the current conductor roster to every row.
    const condQ = await pool.query(
      `SELECT sc.${qi('SC_CSMS_ID')}, up.${qi('Seeker_Name')}, up.${qi('Seeker_Email')}
       FROM ${qi('SCS')}.${qi('Satsang_Conductor')} sc
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = sc.${qi('SC_CSMS_ID')}
       WHERE sc.${qi('Satsang_ID')} = $1 AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [req.params.id]
    );
    const rows = r.rows.map(row => ({ ...row, conductors: condQ.rows }));
    res.json(rows);
  } catch (err) {
    console.error('[GET /satsangs/defs/:id/events] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/defs/:id/events', requireAuth, async (req, res) => {
  const { eventStart, city, duration, reminderDays } = req.body || {};
  if (!eventStart || !city || !duration) {
    return res.status(400).json({ error: 'eventStart, city and duration are required' });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const defQ = await client.query(
      `SELECT ${qi('Satsang_Status')}, ${qi('Satsang_Name')} FROM ${qi('SCS')}.${qi('M_Satsang')} WHERE ${qi('Satsang_ID')} = $1`,
      [req.params.id]
    );
    if (defQ.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND' }); }
    if (defQ.rows[0].Satsang_Status !== 'Approved') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'DEF_NOT_APPROVED', message: 'This satsang definition must be Approved before events can be created.' });
    }

    // Conductors are managed separately via /defs/:id/conductors
    // (SCS.Satsang_Conductor) — no longer set per event.
    const maxQ = await client.query(
      `SELECT COALESCE(MAX(${qi('SE_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')}`
    );
    const seId = maxQ.rows[0].next_id;
    await client.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Event_Defn')}
        (${qi('SE_ID')}, ${qi('Satsang_ID')}, ${qi('Event_ST_DT_TIME')}, ${qi('Event_Time_City')}, ${qi('Event_Duration')},
         ${qi('Reminder_Adv_Notification_Email')})
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [seId, req.params.id, eventStart, city, duration, reminderDays || null]
    );
    await client.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Event_Status')} (${qi('SE_ID')}, ${qi('Current_Status')}, ${qi('Current_Status_Change_Date')})
       VALUES ($1, 'Pending Conductor Approval', CURRENT_DATE)`,
      [seId]
    );

    for (const cId of [sc1Id, sc2Id].filter(Boolean)) {
      await notify(client, cId, `A new "${defQ.rows[0].Satsang_Name}" event needs your approval.`, 'satsang_event', seId);
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, seId });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /satsangs/defs/:id/events] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

router.post('/events/:seId/approve', requireAuth, async (req, res) => {
  await setEventStatus(req, res, 'Scheduled');
});
router.post('/events/:seId/cancel', requireAuth, async (req, res) => {
  await setEventStatus(req, res, 'Cancelled');
});

// One token per (event, attendee) — created once when the event is
// Scheduled; also backfills anyone added as an attendee afterwards, since
// this is safe to call again (ON CONFLICT DO NOTHING). The token itself no
// longer gets "used up" by a single submission — Daily/Weekly fields need
// the same link to work again on a later visit; see routes/public-forms.js
// for how each individual field's own eligibility is checked instead.
async function generateFormTokensForEvent(client, seId, satsangId) {
  const attendeesQ = await client.query(
    `SELECT ${qi('Seeker_ID')} FROM ${qi('SCS')}.${qi('Satsang_Attending_Seekers')}
     WHERE ${qi('Satsang_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
    [satsangId]
  );
  for (const row of attendeesQ.rows) {
    const token = crypto.randomBytes(24).toString('base64url');
    await client.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Event_Form_Tokens')} (${qi('Token')}, ${qi('SE_ID')}, ${qi('Seeker_ID')})
       SELECT $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM ${qi('SCS')}.${qi('Satsang_Event_Form_Tokens')}
         WHERE ${qi('SE_ID')} = $2 AND ${qi('Seeker_ID')} = $3
       )`,
      [token, seId, row.Seeker_ID]
    );
  }
}

async function setEventStatus(req, res, newStatus) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `UPDATE ${qi('SCS')}.${qi('Satsang_Event_Status')}
       SET ${qi('Current_Status')} = $1, ${qi('Current_Status_Change_Date')} = CURRENT_DATE
       WHERE ${qi('SE_ID')} = $2`,
      [newStatus, req.params.seId]
    );
    if (newStatus === 'Scheduled') {
      const evQ = await client.query(
        `SELECT ${qi('Satsang_ID')} FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} WHERE ${qi('SE_ID')} = $1`,
        [req.params.seId]
      );
      if (evQ.rowCount > 0) {
        await generateFormTokensForEvent(client, req.params.seId, evQ.rows[0].Satsang_ID);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[setEventStatus] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
}

// GET /events/:seId/form-links — for staff to copy/share manually (email
// sending is on hold). Regenerates any missing tokens first (covers an
// attendee added after the event was already Scheduled).
router.get('/events/:seId/form-links', requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const evQ = await client.query(
      `SELECT ${qi('Satsang_ID')} FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} WHERE ${qi('SE_ID')} = $1`,
      [req.params.seId]
    );
    if (evQ.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    await generateFormTokensForEvent(client, req.params.seId, evQ.rows[0].Satsang_ID);

    const r = await client.query(
      `SELECT t.${qi('Token')}, t.${qi('Seeker_ID')}, t.${qi('Submitted_DT')}, sk.${qi('First_Name')}, sk.${qi('Last_Name')}
       FROM ${qi('SCS')}.${qi('Satsang_Event_Form_Tokens')} t
       LEFT JOIN ${qi('MSR')}.${qi('Seeker')} sk ON sk.${qi('Seeker_ID')} = t.${qi('Seeker_ID')}
       WHERE t.${qi('SE_ID')} = $1`,
      [req.params.seId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/events/:seId/form-links] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

/* ============ existing attendee/transfer read endpoints (unchanged) ============ */

router.get('/:satsangId/attendees', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sas.${qi('Seeker_ID')}, sas.${qi('Remarks')}, sk.${qi('First_Name')}, sk.${qi('Last_Name')}
       FROM ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} sas
       LEFT JOIN ${qi('MSR')}.${qi('Seeker')} sk ON sk.${qi('Seeker_ID')} = sas.${qi('Seeker_ID')}
       WHERE sas.${qi('Satsang_ID')} = $1 AND sas.${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [req.params.satsangId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /satsangs/:id/attendees] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// Attendee_Transfer_Requests.AS_CSMS_ID was renamed to Seeker_ID (confirmed
// run) — this code previously assumed it hadn't been, which broke this
// endpoint. Also fixed TR_Initiated_By_CSMS_ID -> TR_Initiated_CSMS_ID and
// TR_Remarks -> TR_To_Remarks against the real column list, and added the
// TR_From_* columns (new Release stage, below) to the select.
router.get('/transfers', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tr.${qi('TR_ID')}, tr.${qi('Seeker_ID')} AS seeker_id, tr.${qi('TR_From_Satsang_ID')}, tr.${qi('TR_To_Satsang_ID')},
              tr.${qi('TR_Status_ID')}, ts.${qi('TR_Status_Name')},
              tr.${qi('TR_Initiated_Remarks')}, tr.${qi('TR_Initiated_DT')}, tr.${qi('TR_Initiated_CSMS_ID')},
              tr.${qi('TR_Approver_CSMS_ID')}, tr.${qi('TR_Approver_Remarks')}, tr.${qi('TR_Approved_DT')},
              tr.${qi('TR_From_SC_CSMS_ID')}, tr.${qi('TR_From_Remarks')}, tr.${qi('TR_From_DT')},
              tr.${qi('TR_To_SC_CSMS_ID')}, tr.${qi('TR_To_Remarks')}, tr.${qi('TR_Accepted_DT')},
              sk.${qi('First_Name')} AS attendee_first_name, sk.${qi('Last_Name')} AS attendee_last_name,
              fs.${qi('Satsang_Name')} AS from_satsang_name, ts2.${qi('Satsang_Name')} AS to_satsang_name
       FROM ${qi('SCS')}.${qi('Attendee_Transfer_Requests')} tr
       LEFT JOIN ${qi('SCS')}.${qi('Transfer_Status')} ts ON ts.${qi('TR_Status_ID')} = tr.${qi('TR_Status_ID')}
       LEFT JOIN ${qi('MSR')}.${qi('Seeker')} sk ON sk.${qi('Seeker_ID')} = tr.${qi('Seeker_ID')}
       LEFT JOIN ${qi('SCS')}.${qi('M_Satsang')} fs ON fs.${qi('Satsang_ID')} = tr.${qi('TR_From_Satsang_ID')}
       LEFT JOIN ${qi('SCS')}.${qi('M_Satsang')} ts2 ON ts2.${qi('Satsang_ID')} = tr.${qi('TR_To_Satsang_ID')}
       ORDER BY tr.${qi('TR_Initiated_DT')} DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /satsangs/transfers] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// POST /transfers — initiate a transfer request (stage 1 of 3: Requested).
// Same-type-only: the receiving satsang must share the sending satsang's
// Satsang_Type_ID. TR_Status_ID is resolved by name each time rather than
// hardcoded, since Transfer_Status rows are seeded separately and their
// actual IDs aren't guaranteed.
router.post('/transfers', requireAuth, async (req, res) => {
  const { seekerId, fromSatsangId, toSatsangId, remarks } = req.body || {};
  if (!seekerId || !fromSatsangId || !toSatsangId) {
    return res.status(400).json({ error: 'seekerId, fromSatsangId and toSatsangId are required' });
  }
  if (String(fromSatsangId) === String(toSatsangId)) {
    return res.status(400).json({ error: 'SAME_SATSANG', message: 'From and To satsangs must be different.' });
  }
  try {
    const typesQ = await pool.query(
      `SELECT ${qi('Satsang_ID')}, ${qi('Satsang_Type_ID')} FROM ${qi('SCS')}.${qi('M_Satsang')}
       WHERE ${qi('Satsang_ID')} = ANY($1::bigint[])`,
      [[fromSatsangId, toSatsangId]]
    );
    if (typesQ.rowCount !== 2) return res.status(404).json({ error: 'NOT_FOUND' });
    const fromType = typesQ.rows.find(r => String(r.Satsang_ID) === String(fromSatsangId)).Satsang_Type_ID;
    const toType = typesQ.rows.find(r => String(r.Satsang_ID) === String(toSatsangId)).Satsang_Type_ID;
    if (String(fromType) !== String(toType)) {
      return res.status(409).json({ error: 'TYPE_MISMATCH', message: 'The receiving satsang must be the same type as the sending one.' });
    }

    const statusQ = await pool.query(
      `SELECT ${qi('TR_Status_ID')} FROM ${qi('SCS')}.${qi('Transfer_Status')} WHERE ${qi('TR_Status_Name')} = 'Requested'`
    );
    if (statusQ.rowCount === 0) return res.status(500).json({ error: 'NO_STATUS_ROW', message: '"Requested" is missing from Transfer_Status — seed it first.' });

    const maxQ = await pool.query(
      `SELECT COALESCE(MAX(${qi('TR_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('Attendee_Transfer_Requests')}`
    );
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('Attendee_Transfer_Requests')}
        (${qi('TR_ID')}, ${qi('Seeker_ID')}, ${qi('TR_From_Satsang_ID')}, ${qi('TR_To_Satsang_ID')},
         ${qi('TR_Status_ID')}, ${qi('TR_Initiated_Remarks')}, ${qi('TR_Initiated_DT')}, ${qi('TR_Initiated_CSMS_ID')})
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7)`,
      [id, seekerId, fromSatsangId, toSatsangId, statusQ.rows[0].TR_Status_ID, remarks || null, req.user.csmsId]
    );
    res.status(201).json({ ok: true, trId: id });
  } catch (err) {
    console.error('[POST /satsangs/transfers] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

// Stage 2: Approve or Reject the request itself (not yet moving anyone).
router.post('/transfers/:id/approve', requireAuth, async (req, res) => {
  await setTransferStage(req, res, {
    fromStatuses: ['Requested'], toStatus: 'Approved',
    apply: (client, id) => client.query(
      `UPDATE ${qi('SCS')}.${qi('Attendee_Transfer_Requests')}
       SET ${qi('TR_Approver_CSMS_ID')} = $1, ${qi('TR_Approver_Remarks')} = $2, ${qi('TR_Approved_DT')} = CURRENT_DATE
       WHERE ${qi('TR_ID')} = $3`,
      [req.user.csmsId, (req.body || {}).remarks || null, id]
    ),
  });
});

router.post('/transfers/:id/reject', requireAuth, async (req, res) => {
  await setTransferStage(req, res, {
    fromStatuses: ['Requested', 'Approved'], toStatus: 'Rejected',
    apply: (client, id) => client.query(
      `UPDATE ${qi('SCS')}.${qi('Attendee_Transfer_Requests')}
       SET ${qi('TR_Approver_CSMS_ID')} = $1, ${qi('TR_Approver_Remarks')} = $2, ${qi('TR_Approved_DT')} = CURRENT_DATE
       WHERE ${qi('TR_ID')} = $3`,
      [req.user.csmsId, (req.body || {}).remarks || null, id]
    ),
  });
});

// Stage 3 (new): the SENDING satsang's conductor releases the attendee \u2014
// confirms they're letting them go, before the actual move happens. Sits
// between Approve and Accept, matching the TR_From_* / TR_To_* column
// pairing in the schema (TR_To_* is the receiving side's own confirmation,
// set at Accept below).
router.post('/transfers/:id/release', requireAuth, async (req, res) => {
  await setTransferStage(req, res, {
    fromStatuses: ['Approved'], toStatus: 'Released',
    apply: (client, id) => client.query(
      `UPDATE ${qi('SCS')}.${qi('Attendee_Transfer_Requests')}
       SET ${qi('TR_From_SC_CSMS_ID')} = $1, ${qi('TR_From_Remarks')} = $2, ${qi('TR_From_DT')} = CURRENT_DATE
       WHERE ${qi('TR_ID')} = $3`,
      [req.user.csmsId, (req.body || {}).remarks || null, id]
    ),
  });
});

// Stage 4: Accept — this is what actually moves the attendee. Expires their
// Satsang_Attending_Seekers row on the sending satsang and creates a fresh
// one on the receiving satsang. Now gated on Released (the sending
// conductor's own confirmation), not directly on Approved.
router.post('/transfers/:id/accept', requireAuth, async (req, res) => {
  await setTransferStage(req, res, {
    fromStatuses: ['Released'], toStatus: 'Accepted',
    apply: async (client, id) => {
      const trQ = await client.query(
        `SELECT ${qi('Seeker_ID')} AS seeker_id, ${qi('TR_From_Satsang_ID')}, ${qi('TR_To_Satsang_ID')}
         FROM ${qi('SCS')}.${qi('Attendee_Transfer_Requests')} WHERE ${qi('TR_ID')} = $1`,
        [id]
      );
      const tr = trQ.rows[0];
      await client.query(
        `UPDATE ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
         WHERE ${qi('Satsang_ID')} = $1 AND ${qi('Seeker_ID')} = $2 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
        [tr.TR_From_Satsang_ID, tr.seeker_id]
      );
      await client.query(
        `INSERT INTO ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} (${qi('Satsang_ID')}, ${qi('Seeker_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
         VALUES ($1, $2, CURRENT_DATE, $3)`,
        [tr.TR_To_Satsang_ID, tr.seeker_id, FAR_FUTURE]
      );
      await client.query(
        `UPDATE ${qi('SCS')}.${qi('Attendee_Transfer_Requests')}
         SET ${qi('TR_To_SC_CSMS_ID')} = $1, ${qi('TR_To_Remarks')} = $2, ${qi('TR_Accepted_DT')} = CURRENT_DATE
         WHERE ${qi('TR_ID')} = $3`,
        [req.user.csmsId, (req.body || {}).remarks || null, id]
      );
    },
  });
});

async function setTransferStage(req, res, { fromStatuses, toStatus, apply }) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT ts.${qi('TR_Status_Name')} FROM ${qi('SCS')}.${qi('Attendee_Transfer_Requests')} tr
       JOIN ${qi('SCS')}.${qi('Transfer_Status')} ts ON ts.${qi('TR_Status_ID')} = tr.${qi('TR_Status_ID')}
       WHERE tr.${qi('TR_ID')} = $1 FOR UPDATE OF tr`,
      [req.params.id]
    );
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND' }); }
    if (!fromStatuses.includes(cur.rows[0].TR_Status_Name)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'BAD_STATE', message: `Must be ${fromStatuses.join(' or ')} to do this — it's currently ${cur.rows[0].TR_Status_Name}.` });
    }
    const statusQ = await client.query(
      `SELECT ${qi('TR_Status_ID')} FROM ${qi('SCS')}.${qi('Transfer_Status')} WHERE ${qi('TR_Status_Name')} = $1`,
      [toStatus]
    );
    if (statusQ.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'NO_STATUS_ROW', message: `"${toStatus}" is missing from Transfer_Status — seed it first.` });
    }

    await apply(client, req.params.id);
    await client.query(
      `UPDATE ${qi('SCS')}.${qi('Attendee_Transfer_Requests')} SET ${qi('TR_Status_ID')} = $1 WHERE ${qi('TR_ID')} = $2`,
      [statusQ.rows[0].TR_Status_ID, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[setTransferStage] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
}

/* ============ Satsangs_Seva_Dept_Access (configuration only — not
   enforced anywhere yet, per instruction: everyone has access for now) ============ */

router.get('/access-config', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sda.${qi('Satsang_Access_ID')}, sda.${qi('Satsang_Function')}, sda.${qi('Seva_Dept_ID')},
              d.${qi('Seva_Dept_Name')},
              sda.${qi('Satsang_Create_Role_ID')}, sda.${qi('Satsang_Review_Role_ID')},
              sda.${qi('Satsang_Approve_Role_ID')}, sda.${qi('Satsang_Notify_Role_ID')}
       FROM ${qi('SCS')}.${qi('Satsangs_Seva_Dept_Access')} sda
       LEFT JOIN ${qi('RMS')}.${qi('Seva_Dept')} d ON d.${qi('Seva_Dept_ID')} = sda.${qi('Seva_Dept_ID')}
       WHERE sda.${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY d.${qi('Seva_Dept_Name')}, sda.${qi('Satsang_Function')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/access-config] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/access-config', requireAuth, async (req, res) => {
  const { satsangFunction, sevaDeptId, createRoleId, reviewRoleIds, approveRoleIds, notifyRoleIds } = req.body || {};
  if (!satsangFunction || !sevaDeptId) {
    return res.status(400).json({ error: 'satsangFunction and sevaDeptId are required' });
  }
  try {
    const maxQ = await pool.query(
      `SELECT COALESCE(MAX(${qi('Satsang_Access_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('Satsangs_Seva_Dept_Access')}`
    );
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsangs_Seva_Dept_Access')}
        (${qi('Satsang_Access_ID')}, ${qi('Satsang_Function')}, ${qi('Seva_Dept_ID')},
         ${qi('Satsang_Create_Role_ID')}, ${qi('Satsang_Review_Role_ID')}, ${qi('Satsang_Approve_Role_ID')}, ${qi('Satsang_Notify_Role_ID')},
         ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8)`,
      [id, satsangFunction, sevaDeptId, createRoleId || null, reviewRoleIds || null, approveRoleIds || null, notifyRoleIds || null, FAR_FUTURE]
    );
    res.status(201).json({ ok: true, accessId: id });
  } catch (err) {
    console.error('[POST /satsangs/access-config] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.delete('/access-config/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('Satsangs_Seva_Dept_Access')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Satsang_Access_ID')} = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /satsangs/access-config/:id] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Satsang Comments (per attending seeker, per event) ============
   No surrogate PK given in the schema — added Comment_ID here since a
   seeker can reasonably get more than one comment over time, same
   reasoning as MSD_ID/SEFV_ID elsewhere in this file. SC_CSMS_ID is
   attributed to one of the EVENT's own two conductors (SC1/SC2), not
   just whoever's logged in — matches Satsang_Conductor's own identity. */

router.get('/events/:seId/comments', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.${qi('Comment_ID')}, c.${qi('Seeker_ID')}, c.${qi('SC_CSMS_ID')}, c.${qi('Comments')}, c.${qi('Comments_Date')},
              sk.${qi('First_Name')}, sk.${qi('Last_Name')}, up.${qi('Seeker_Name')} AS conductor_name
       FROM ${qi('SCS')}.${qi('Satsang_Seeker_Comments')} c
       LEFT JOIN ${qi('MSR')}.${qi('Seeker')} sk ON sk.${qi('Seeker_ID')} = c.${qi('Seeker_ID')}
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = c.${qi('SC_CSMS_ID')}
       WHERE c.${qi('SE_ID')} = $1
       ORDER BY c.${qi('Comments_Date')} DESC, c.${qi('Comment_ID')} DESC`,
      [req.params.seId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/events/:seId/comments] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/events/:seId/comments', requireAuth, async (req, res) => {
  const { seekerId, scCsmsId, comments } = req.body || {};
  if (!seekerId || !scCsmsId || !comments) {
    return res.status(400).json({ error: 'seekerId, scCsmsId and comments are all required' });
  }
  try {
    const maxQ = await pool.query(
      `SELECT COALESCE(MAX(${qi('Comment_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('Satsang_Seeker_Comments')}`
    );
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Seeker_Comments')}
        (${qi('Comment_ID')}, ${qi('SE_ID')}, ${qi('SC_CSMS_ID')}, ${qi('Seeker_ID')}, ${qi('Comments')}, ${qi('Comments_Date')})
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE)`,
      [id, req.params.seId, scCsmsId, seekerId, comments]
    );
    res.status(201).json({ ok: true, commentId: id });
  } catch (err) {
    console.error('[POST /satsangs/events/:seId/comments] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

// POST /events/:seId/comments/bulk — one conductor, notes for several
// attendees in a single submit (grid-style entry). Entries with an empty
// comment are skipped rather than saved as blank rows.
router.post('/events/:seId/comments/bulk', requireAuth, async (req, res) => {
  const { scCsmsId, entries } = req.body || {};
  if (!scCsmsId || !Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ error: 'scCsmsId and a non-empty entries array are required' });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    let saved = 0;
    for (const entry of entries) {
      const comments = (entry.comments || '').trim();
      if (!entry.seekerId || !comments) continue;
      const maxQ = await client.query(
        `SELECT COALESCE(MAX(${qi('Comment_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('Satsang_Seeker_Comments')}`
      );
      const id = maxQ.rows[0].next_id;
      await client.query(
        `INSERT INTO ${qi('SCS')}.${qi('Satsang_Seeker_Comments')}
          (${qi('Comment_ID')}, ${qi('SE_ID')}, ${qi('SC_CSMS_ID')}, ${qi('Seeker_ID')}, ${qi('Comments')}, ${qi('Comments_Date')})
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE)`,
        [id, req.params.seId, scCsmsId, entry.seekerId, comments]
      );
      saved++;
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, saved });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /satsangs/events/:seId/comments/bulk] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});


router.delete('/comments/:commentId', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM ${qi('SCS')}.${qi('Satsang_Seeker_Comments')} WHERE ${qi('Comment_ID')} = $1`, [req.params.commentId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /satsangs/comments/:commentId] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Conductor_Satsang_Comments (one overall report, per
   conductor, per event \u2014 distinct from Satsang_Comments above, which is
   per-attendee) ============
   Built exactly as specified: CSC_ID surrogate PK, CS_CSMS_ID (conductor,
   same FK meaning as SC_CSMS_ID elsewhere), SE_ID (event), Satsang_Report
   (TEXT). No date column was given, so this is treated as ONE report per
   (SE_ID, CS_CSMS_ID) that gets overwritten on save, not a running log \u2014
   flagged in chat, not silently added. */

router.get('/events/:seId/conductor-report', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cr.${qi('CSC_ID')}, cr.${qi('CS_CSMS_ID')}, cr.${qi('Satsang_Report')}, up.${qi('Seeker_Name')} AS conductor_name
       FROM ${qi('SCS')}.${qi('Satsang_Comments')} cr
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = cr.${qi('CS_CSMS_ID')}
       WHERE cr.${qi('SE_ID')} = $1`,
      [req.params.seId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/events/:seId/conductor-report] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// Upsert: one row per (SE_ID, CS_CSMS_ID). Saving again overwrites the
// same report rather than adding a new row.
router.put('/events/:seId/conductor-report', requireAuth, async (req, res) => {
  const { csCsmsId, report } = req.body || {};
  if (!csCsmsId) return res.status(400).json({ error: 'csCsmsId is required' });
  try {
    const existing = await pool.query(
      `SELECT ${qi('CSC_ID')} FROM ${qi('SCS')}.${qi('Satsang_Comments')}
       WHERE ${qi('SE_ID')} = $1 AND ${qi('CS_CSMS_ID')} = $2`,
      [req.params.seId, csCsmsId]
    );
    if (existing.rowCount) {
      await pool.query(
        `UPDATE ${qi('SCS')}.${qi('Satsang_Comments')} SET ${qi('Satsang_Report')} = $1 WHERE ${qi('CSC_ID')} = $2`,
        [report || null, existing.rows[0].CSC_ID]
      );
      return res.json({ ok: true, cscId: existing.rows[0].CSC_ID });
    }
    const maxQ = await pool.query(
      `SELECT COALESCE(MAX(${qi('CSC_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('Satsang_Comments')}`
    );
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Comments')}
        (${qi('CSC_ID')}, ${qi('CS_CSMS_ID')}, ${qi('SE_ID')}, ${qi('Satsang_Report')})
       VALUES ($1,$2,$3,$4)`,
      [id, csCsmsId, req.params.seId, report || null]
    );
    res.status(201).json({ ok: true, cscId: id });
  } catch (err) {
    console.error('[PUT /satsangs/events/:seId/conductor-report] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

module.exports = router;
