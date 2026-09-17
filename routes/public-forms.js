// routes/public-forms.js — the ONLY unauthenticated routes in this API.
// Deliberately kept separate from every other route file so it's obvious
// at a glance that nothing here goes through requireAuth. A token in the
// URL is the only "identity" here — anyone with the link can fill the
// form once. No email sending yet (on hold) — links are generated and
// shared by staff manually for now.

const express = require('express');
const { pool, qi } = require('../db/pool');
const router = express.Router();

// GET /api/public/satsang-form/:token — what the public page needs to
// render: satsang/event context, the seeker's name, and the field
// definitions to build the form from (M_Satsang_Defn).
router.get('/satsang-form/:token', async (req, res) => {
  try {
    const tokQ = await pool.query(
      `SELECT t.${qi('SE_ID')}, t.${qi('Seeker_ID')}, t.${qi('Submitted_DT')}
       FROM ${qi('SCS')}.${qi('Satsang_Event_Form_Tokens')} t WHERE t.${qi('Token')} = $1`,
      [req.params.token]
    );
    if (tokQ.rowCount === 0) return res.status(404).json({ error: 'INVALID_TOKEN', message: 'This link is not valid.' });
    const tok = tokQ.rows[0];
    if (tok.Submitted_DT) return res.status(409).json({ error: 'ALREADY_SUBMITTED', message: 'This form has already been submitted.' });

    const evQ = await pool.query(
      `SELECT se.${qi('Satsang_ID')}, se.${qi('Event_ST_DT_TIME')}, se.${qi('Event_Time_City')}, ms.${qi('Satsang_Name')}
       FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} se
       JOIN ${qi('SCS')}.${qi('M_Satsang')} ms ON ms.${qi('Satsang_ID')} = se.${qi('Satsang_ID')}
       WHERE se.${qi('SE_ID')} = $1`,
      [tok.SE_ID]
    );
    if (evQ.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    const ev = evQ.rows[0];

    const skQ = await pool.query(`SELECT ${qi('First_Name')}, ${qi('Last_Name')} FROM ${qi('MSR')}.${qi('Seeker')} WHERE ${qi('Seeker_ID')} = $1`, [tok.Seeker_ID]);
    const fieldsQ = await pool.query(
      `SELECT ${qi('Field_Name')}, ${qi('Field_Data_Type')}, ${qi('QLT_FIELD')}, ${qi('QTY_FIELD')}, ${qi('Display_Order')}
       FROM ${qi('SCS')}.${qi('M_Satsang_Defn')}
       WHERE ${qi('Satsang_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY ${qi('Display_Order')} NULLS LAST, ${qi('Field_Name')}`,
      [ev.Satsang_ID]
    );

    res.json({
      satsangName: ev.Satsang_Name,
      eventCity: ev.Event_Time_City,
      eventTime: ev.Event_ST_DT_TIME,
      seekerName: skQ.rowCount ? [skQ.rows[0].First_Name, skQ.rows[0].Last_Name].filter(Boolean).join(' ') : '',
      fields: fieldsQ.rows,
    });
  } catch (err) {
    console.error('[GET /public/satsang-form/:token] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// POST /api/public/satsang-form/:token — write the submitted values into
// the per-satsang dynamic table (EAV rows: one per field), then mark the
// token used so the link can't be submitted twice.
router.post('/satsang-form/:token', async (req, res) => {
  const { values } = req.body || {};
  if (!values || typeof values !== 'object') return res.status(400).json({ error: 'values is required' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const tokQ = await client.query(
      `SELECT ${qi('SE_ID')}, ${qi('Seeker_ID')}, ${qi('Submitted_DT')}
       FROM ${qi('SCS')}.${qi('Satsang_Event_Form_Tokens')} WHERE ${qi('Token')} = $1 FOR UPDATE`,
      [req.params.token]
    );
    if (tokQ.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'INVALID_TOKEN' }); }
    const tok = tokQ.rows[0];
    if (tok.Submitted_DT) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ALREADY_SUBMITTED' }); }

    const evQ = await client.query(
      `SELECT ${qi('Satsang_ID')} FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} WHERE ${qi('SE_ID')} = $1`,
      [tok.SE_ID]
    );
    if (evQ.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND' }); }
    const satsangId = Number(evQ.rows[0].Satsang_ID);
    if (!Number.isInteger(satsangId)) { await client.query('ROLLBACK'); return res.status(500).json({ error: 'INTERNAL' }); }

    // Only accept field names that are actually defined for this satsang —
    // never trust the submitted keys directly as free-form data shape.
    const defQ = await client.query(
      `SELECT ${qi('Field_Name')} FROM ${qi('SCS')}.${qi('M_Satsang_Defn')}
       WHERE ${qi('Satsang_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [satsangId]
    );
    const validFields = new Set(defQ.rows.map(r => r.Field_Name));

    await client.query(
      `CREATE TABLE IF NOT EXISTS ${qi('SCS')}.${qi('SS_' + satsangId + '_Event_Forms')} (
         "SE_ID" BIGINT NOT NULL,
         "Seeker_ID" BIGINT NOT NULL,
         "Field_Name" TEXT NOT NULL,
         "Field_Value" TEXT,
         "Submitted_DT" TIMESTAMPTZ
       )`
    );

    for (const [fieldName, fieldValue] of Object.entries(values)) {
      if (!validFields.has(fieldName)) continue;
      await client.query(
        `INSERT INTO ${qi('SCS')}.${qi('SS_' + satsangId + '_Event_Forms')}
          ("SE_ID", "Seeker_ID", "Field_Name", "Field_Value", "Submitted_DT")
         VALUES ($1, $2, $3, $4, now())`,
        [tok.SE_ID, tok.Seeker_ID, fieldName, fieldValue == null ? null : String(fieldValue)]
      );
    }

    await client.query(
      `UPDATE ${qi('SCS')}.${qi('Satsang_Event_Form_Tokens')} SET ${qi('Submitted_DT')} = now() WHERE ${qi('Token')} = $1`,
      [req.params.token]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /public/satsang-form/:token] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
