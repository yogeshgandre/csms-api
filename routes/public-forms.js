// routes/public-forms.js — the ONLY unauthenticated routes in this API.
// Deliberately kept separate from every other route file so it's obvious
// at a glance that nothing here goes through requireAuth. A token in the
// URL is the only "identity" here — anyone with the link can use it,
// repeatedly if the satsang has Daily/Weekly fields. No email sending yet
// (on hold) — links are generated and shared by staff manually for now.
//
// Redesigned around Satsang_Event_Field_Values as a single shared table
// (was one dynamically-created table per satsang) and per-field
// Review_Frequency on M_Satsang_Defn ('One-time'|'Daily'|'Weekly'):
// eligibility to submit a given field is worked out fresh on every visit
// instead of the token being marked "used" after one submission — a
// Daily/Weekly field needs the same link to work again later.

const express = require('express');
const { pool, qi } = require('../db/pool');
const router = express.Router();

// Monday of the current week, as a plain YYYY-MM-DD string — used as the
// period boundary for Weekly fields.
function currentWeekStart() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
  return monday.toISOString().slice(0, 10);
}

async function loadTokenContext(token) {
  const tokQ = await pool.query(
    `SELECT t.${qi('SE_ID')}, t.${qi('Seeker_ID')}
     FROM ${qi('SCS')}.${qi('Satsang_Event_Form_Tokens')} t WHERE t.${qi('Token')} = $1`,
    [token]
  );
  if (tokQ.rowCount === 0) return null;
  const tok = tokQ.rows[0];
  const evQ = await pool.query(
    `SELECT se.${qi('Satsang_ID')}, se.${qi('Event_ST_DT_TIME')}, se.${qi('Event_Time_City')}, ms.${qi('Satsang_Name')}
     FROM ${qi('SCS')}.${qi('Satsang_Event_Defn')} se
     JOIN ${qi('SCS')}.${qi('M_Satsang')} ms ON ms.${qi('Satsang_ID')} = se.${qi('Satsang_ID')}
     WHERE se.${qi('SE_ID')} = $1`,
    [tok.SE_ID]
  );
  if (evQ.rowCount === 0) return null;
  return { ...tok, ...evQ.rows[0] };
}

// GET /api/public/satsang-form/:token — field definitions plus, for each
// one, whether it's currently open to fill in (per its own cadence) and
// what was last submitted for it, if anything.
router.get('/satsang-form/:token', async (req, res) => {
  try {
    const ctx = await loadTokenContext(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'INVALID_TOKEN', message: 'This link is not valid.' });

    const skQ = await pool.query(`SELECT ${qi('First_Name')}, ${qi('Last_Name')} FROM ${qi('MSR')}.${qi('Seeker')} WHERE ${qi('Seeker_ID')} = $1`, [ctx.Seeker_ID]);
    const fieldsQ = await pool.query(
      `SELECT ${qi('Field_Name')}, ${qi('Field_Data_Type')}, ${qi('Review_Frequency')}, ${qi('Display_Order')}
       FROM ${qi('SCS')}.${qi('M_Satsang_Defn')}
       WHERE ${qi('Satsang_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY ${qi('Display_Order')} NULLS LAST, ${qi('Field_Name')}`,
      [ctx.Satsang_ID]
    );

    const weekStart = currentWeekStart();
    const fields = [];
    for (const f of fieldsQ.rows) {
      let existingQ;
      if (f.Review_Frequency === 'Daily') {
        existingQ = await pool.query(
          `SELECT ${qi('Field_Value')} FROM ${qi('SCS')}.${qi('Satsang_Event_Field_Values')}
           WHERE ${qi('SE_ID')} = $1 AND ${qi('Seeker_ID')} = $2 AND ${qi('Field_Name')} = $3 AND ${qi('Review_Date')} = CURRENT_DATE
           ORDER BY ${qi('Submitted_DT')} DESC LIMIT 1`,
          [ctx.SE_ID, ctx.Seeker_ID, f.Field_Name]
        );
      } else if (f.Review_Frequency === 'Weekly') {
        existingQ = await pool.query(
          `SELECT ${qi('Field_Value')} FROM ${qi('SCS')}.${qi('Satsang_Event_Field_Values')}
           WHERE ${qi('SE_ID')} = $1 AND ${qi('Seeker_ID')} = $2 AND ${qi('Field_Name')} = $3 AND ${qi('Review_Date')} >= $4
           ORDER BY ${qi('Submitted_DT')} DESC LIMIT 1`,
          [ctx.SE_ID, ctx.Seeker_ID, f.Field_Name, weekStart]
        );
      } else {
        existingQ = await pool.query(
          `SELECT ${qi('Field_Value')} FROM ${qi('SCS')}.${qi('Satsang_Event_Field_Values')}
           WHERE ${qi('SE_ID')} = $1 AND ${qi('Seeker_ID')} = $2 AND ${qi('Field_Name')} = $3
           ORDER BY ${qi('Submitted_DT')} DESC LIMIT 1`,
          [ctx.SE_ID, ctx.Seeker_ID, f.Field_Name]
        );
      }
      fields.push({
        ...f,
        alreadySubmitted: existingQ.rowCount > 0,
        lastValue: existingQ.rowCount > 0 ? existingQ.rows[0].Field_Value : null,
      });
    }

    res.json({
      satsangName: ctx.Satsang_Name,
      eventCity: ctx.Event_Time_City,
      eventTime: ctx.Event_ST_DT_TIME,
      seekerName: skQ.rowCount ? [skQ.rows[0].First_Name, skQ.rows[0].Last_Name].filter(Boolean).join(' ') : '',
      fields,
    });
  } catch (err) {
    console.error('[GET /public/satsang-form/:token] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// POST /api/public/satsang-form/:token — accepts values for whichever
// fields are actually open right now; anything not currently eligible
// (already given today/this week/ever, depending on its cadence) is
// silently skipped rather than trusted from the client.
router.post('/satsang-form/:token', async (req, res) => {
  const { values } = req.body || {};
  if (!values || typeof values !== 'object') return res.status(400).json({ error: 'values is required' });
  let client;
  try {
    const ctx = await loadTokenContext(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'INVALID_TOKEN' });

    client = await pool.connect();
    await client.query('BEGIN');

    const defQ = await client.query(
      `SELECT ${qi('Field_Name')}, ${qi('Review_Frequency')} FROM ${qi('SCS')}.${qi('M_Satsang_Defn')}
       WHERE ${qi('Satsang_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [ctx.Satsang_ID]
    );
    const freqByField = new Map(defQ.rows.map(r => [r.Field_Name, r.Review_Frequency]));
    const weekStart = currentWeekStart();
    let accepted = 0;

    for (const [fieldName, fieldValue] of Object.entries(values)) {
      const freq = freqByField.get(fieldName);
      if (!freq) continue; // not a real field on this satsang — ignore rather than trust the client

      let existingQ;
      if (freq === 'Daily') {
        existingQ = await client.query(
          `SELECT 1 FROM ${qi('SCS')}.${qi('Satsang_Event_Field_Values')}
           WHERE ${qi('SE_ID')} = $1 AND ${qi('Seeker_ID')} = $2 AND ${qi('Field_Name')} = $3 AND ${qi('Review_Date')} = CURRENT_DATE`,
          [ctx.SE_ID, ctx.Seeker_ID, fieldName]
        );
      } else if (freq === 'Weekly') {
        existingQ = await client.query(
          `SELECT 1 FROM ${qi('SCS')}.${qi('Satsang_Event_Field_Values')}
           WHERE ${qi('SE_ID')} = $1 AND ${qi('Seeker_ID')} = $2 AND ${qi('Field_Name')} = $3 AND ${qi('Review_Date')} >= $4`,
          [ctx.SE_ID, ctx.Seeker_ID, fieldName, weekStart]
        );
      } else {
        existingQ = await client.query(
          `SELECT 1 FROM ${qi('SCS')}.${qi('Satsang_Event_Field_Values')}
           WHERE ${qi('SE_ID')} = $1 AND ${qi('Seeker_ID')} = $2 AND ${qi('Field_Name')} = $3`,
          [ctx.SE_ID, ctx.Seeker_ID, fieldName]
        );
      }
      if (existingQ.rowCount > 0) continue; // already given for this period — skip, don't overwrite

      const maxQ = await client.query(
        `SELECT COALESCE(MAX(${qi('SEFV_ID')}), 0) + 1 AS next_id FROM ${qi('SCS')}.${qi('Satsang_Event_Field_Values')}`
      );
      await client.query(
        `INSERT INTO ${qi('SCS')}.${qi('Satsang_Event_Field_Values')}
          (${qi('SEFV_ID')}, ${qi('SE_ID')}, ${qi('Seeker_ID')}, ${qi('Field_Name')}, ${qi('Field_Value')}, ${qi('Review_Date')}, ${qi('Submitted_DT')})
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,now())`,
        [maxQ.rows[0].next_id, ctx.SE_ID, ctx.Seeker_ID, fieldName, fieldValue == null ? null : String(fieldValue)]
      );
      accepted++;
    }

    await client.query('COMMIT');
    res.json({ ok: true, accepted });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /public/satsang-form/:token] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
