// routes/satsangs.js — Satsang Management: definitions (with review/approve
// workflow), dynamic per-satsang fields, conductor roster, attending
// seekers, and events (blocked until the definition is Approved, and each
// event itself needs a conductor's approval before it counts as Scheduled).
//
// NOTE: Event_ST_DT_TIME is being migrated to TIMESTAMPTZ (was bigint unix
// seconds) — the /upcoming query below already assumes the new type.
//
// NOTE: Satsang_Conductor and Satsang_Attending_Seekers have no surrogate
// PK — just (Satsang_ID, *_CSMS_ID) — so those rows are addressed by that
// pair rather than a single id, unlike everything else in this file.
//
// NOTE: "Attending Seeker" is modeled via AS_CSMS_ID, i.e. through the same
// RMS.User_Profile/CSMS_ID identity used for staff — not MSR.Seeker. That's
// what the schema gives us; flagging it as a modeling oddity worth a second
// look, not something invented here.

const express = require('express');
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
    const r = await pool.query(
      `SELECT ${qi('Satsang_Type_ID')}, ${qi('ST_Name')}, ${qi('SS_Desc')}
       FROM ${qi('SCS')}.${qi('M_Satsang_type')} WHERE ${qi('Active_Flag')} = true ORDER BY ${qi('ST_Name')}`
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
         WHERE ${qi('Dept_Role_ID')} = ANY($1::bigint[])
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

/* ============ Dynamic fields (M_Satsang_Defn) ============ */

router.get('/defs/:id/fields', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('MSD_ID')}, ${qi('Field_Name')}, ${qi('Field_Data_Type')}, ${qi('GLT_FIELD')}, ${qi('QTY_FIELD')}, ${qi('Display_Order')}
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
  const { fieldName, dataType, isGlt, isQty, displayOrder } = req.body || {};
  if (!fieldName) return res.status(400).json({ error: 'fieldName is required' });
  try {
    const maxQ = await pool.query(
      `SELECT COALESCE(MAX(${qi('MSD_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('M_Satsang_Defn')}`
    );
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('SCS')}.${qi('M_Satsang_Defn')}
        (${qi('MSD_ID')}, ${qi('Satsang_ID')}, ${qi('Field_Name')}, ${qi('Field_Data_Type')}, ${qi('GLT_FIELD')}, ${qi('QTY_FIELD')}, ${qi('Display_Order')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8)`,
      [id, req.params.id, fieldName, dataType || 'text', !!isGlt, !!isQty, displayOrder || null, FAR_FUTURE]
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
   Same no-surrogate-PK situation as conductors. */

router.get('/defs/:id/attendees', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sas.${qi('AS_CSMS_ID')}, sas.${qi('Remarks')}, up.${qi('Seeker_Name')}, up.${qi('Seeker_Email')}
       FROM ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} sas
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = sas.${qi('AS_CSMS_ID')}
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
  const { email, name, remarks } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const profile = await findOrCreateProfile(client, email, name);
    await client.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Attending_Seekers')}
        (${qi('Satsang_ID')}, ${qi('AS_CSMS_ID')}, ${qi('Remarks')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, $3, CURRENT_DATE, $4)`,
      [req.params.id, profile.csmsId, remarks || null, FAR_FUTURE]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, name: profile.name, profileCreated: profile.created });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /satsangs/defs/:id/attendees] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

router.delete('/defs/:id/attendees/:csmsId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Satsang_ID')} = $1 AND ${qi('AS_CSMS_ID')} = $2`,
      [req.params.id, req.params.csmsId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /satsangs/defs/:id/attendees/:csmsId] error', err);
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
              se.${qi('SC1_CSMS_ID')}, se.${qi('SC2_CSMS_ID')},
              sc1.${qi('Seeker_Name')} AS sc1_name, sc2.${qi('Seeker_Name')} AS sc2_name,
              est.${qi('Current_Status')}, est.${qi('Event_Link')}, est.${qi('Current_Status_Change_Date')}
       FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} se
       LEFT JOIN ${qi('SCS')}.${qi('Satsang_Event_Status')} est ON est.${qi('SE_ID')} = se.${qi('SE_ID')}
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} sc1 ON sc1.${qi('CSMS_ID')} = se.${qi('SC1_CSMS_ID')}
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} sc2 ON sc2.${qi('CSMS_ID')} = se.${qi('SC2_CSMS_ID')}
       WHERE se.${qi('Satsang_ID')} = $1
       ORDER BY se.${qi('Event_ST_DT_TIME')} DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /satsangs/defs/:id/events] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/defs/:id/events', requireAuth, async (req, res) => {
  const { eventStart, city, duration, sc1Email, sc1Name, sc2Email, sc2Name, reminderDays } = req.body || {};
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

    // Conductors can be anyone (open, not restricted to a roster) — same
    // email-based auto-provisioning as conductors/attendees/assign-role.
    let sc1Id = null, sc2Id = null;
    if (sc1Email) sc1Id = (await findOrCreateProfile(client, sc1Email, sc1Name)).csmsId;
    if (sc2Email) sc2Id = (await findOrCreateProfile(client, sc2Email, sc2Name)).csmsId;

    const maxQ = await client.query(
      `SELECT COALESCE(MAX(${qi('SE_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')}`
    );
    const seId = maxQ.rows[0].next_id;
    await client.query(
      `INSERT INTO ${qi('SCS')}.${qi('Satsang_Event_Defn')}
        (${qi('SE_ID')}, ${qi('Satsang_ID')}, ${qi('Event_ST_DT_TIME')}, ${qi('Event_Time_City')}, ${qi('Event_Duration')},
         ${qi('SC1_CSMS_ID')}, ${qi('SC2_CSMS_ID')}, ${qi('Reminder_Adv_Notification_Email')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [seId, req.params.id, eventStart, city, duration, sc1Id, sc2Id, reminderDays || null]
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

async function setEventStatus(req, res, newStatus) {
  try {
    await pool.query(
      `UPDATE ${qi('SCS')}.${qi('Satsang_Event_Status')}
       SET ${qi('Current_Status')} = $1, ${qi('Current_Status_Change_Date')} = CURRENT_DATE
       WHERE ${qi('SE_ID')} = $2`,
      [newStatus, req.params.seId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[setEventStatus] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
}

/* ============ existing attendee/transfer read endpoints (unchanged) ============ */

router.get('/:satsangId/attendees', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sas.${qi('AS_CSMS_ID')}, sas.${qi('Remarks')}, up.${qi('Seeker_Name')}
       FROM ${qi('SCS')}.${qi('Satsang_Attending_Seekers')} sas
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = sas.${qi('AS_CSMS_ID')}
       WHERE sas.${qi('Satsang_ID')} = $1 AND sas.${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [req.params.satsangId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /satsangs/:id/attendees] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.get('/transfers', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tr.*, ts.${qi('TR_Status_Name')}
       FROM ${qi('SCS')}.${qi('Attendee_Transfer_Requests')} tr
       LEFT JOIN ${qi('SCS')}.${qi('Transfer_Status')} ts ON ts.${qi('TR_Status_ID')} = tr.${qi('TR_Status_ID')}
       ORDER BY tr.${qi('TR_Initiated_DT')} DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /satsangs/transfers] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
