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

/* ============ Curious Intake public form (FMS) ============
   A plain public page per form — no token, same form for everyone, per
   instruction. Only reachable while the form's Current_Status resolves to
   Published (Paused/Draft/In Review/Archived all reject). Collects the
   mandatory Form_Submission_Key_Details fields plus whatever
   Form_Additional_Fields questions that form defines. */

const MANDATORY_INTAKE_FIELDS = [
  { name: 'Sal', label: 'Salutation', type: 'text', required: false },
  { name: 'First_Name', label: 'First name', type: 'text', required: true },
  { name: 'Last_Name', label: 'Last name', type: 'text', required: true },
  { name: 'City', label: 'City', type: 'text', required: true },
  { name: 'Country_ID', label: 'Country', type: 'country', required: true },
  { name: 'WhatsApp_Number', label: 'WhatsApp number', type: 'number', required: true },
  { name: 'Email', label: 'Email', type: 'email', required: true },
];

router.get('/intake-form/:formId', async (req, res) => {
  try {
    const formQ = await pool.query(
      `SELECT fc.${qi('Form_ID')}, fs.${qi('Form_Status_Name')}
       FROM ${qi('FMS')}.${qi('Form_Creation_Process')} fc
       LEFT JOIN ${qi('FMS')}.${qi('Form_Status')} fs ON fs.${qi('Form_Status_ID')} = fc.${qi('Current_Status')}
       WHERE fc.${qi('Form_ID')} = $1`,
      [req.params.formId]
    );
    if (formQ.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    if (formQ.rows[0].Form_Status_Name !== 'Published') {
      return res.status(409).json({ error: 'NOT_PUBLISHED', message: 'This form is not currently open.' });
    }

    const fieldsQ = await pool.query(
      `SELECT ${qi('Question_Name')}, ${qi('Question_Type')}, ${qi('Component_Type')}
       FROM ${qi('FMS')}.${qi('Form_Additional_Fields')}
       WHERE ${qi('Form_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY ${qi('FAF_ID')}`,
      [req.params.formId]
    );
    const countriesQ = await pool.query(
      `SELECT ${qi('Country_ID')}, ${qi('Country_Name')} FROM ${qi('Master')}.${qi('M_Country')} ORDER BY ${qi('Country_Name')}`
    );

    res.json({
      mandatoryFields: MANDATORY_INTAKE_FIELDS,
      additionalFields: fieldsQ.rows,
      countries: countriesQ.rows,
    });
  } catch (err) {
    console.error('[GET /public/intake-form/:formId] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/intake-form/:formId', async (req, res) => {
  const { mandatory, additional } = req.body || {};
  if (!mandatory) return res.status(400).json({ error: 'mandatory is required' });
  for (const f of MANDATORY_INTAKE_FIELDS) {
    if (f.required && !mandatory[f.name]) return res.status(400).json({ error: 'MISSING_FIELD', message: `${f.label} is required.` });
  }
  let client;
  try {
    const formQ = await pool.query(
      `SELECT fc.${qi('Form_ID')}, fs.${qi('Form_Status_Name')}
       FROM ${qi('FMS')}.${qi('Form_Creation_Process')} fc
       LEFT JOIN ${qi('FMS')}.${qi('Form_Status')} fs ON fs.${qi('Form_Status_ID')} = fc.${qi('Current_Status')}
       WHERE fc.${qi('Form_ID')} = $1`,
      [req.params.formId]
    );
    if (formQ.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    if (formQ.rows[0].Form_Status_Name !== 'Published') {
      return res.status(409).json({ error: 'NOT_PUBLISHED', message: 'This form is not currently open.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Country and Country_ISD are NOT NULL in the original schema, even
    // though Country_ID is now the real source of truth — derive both
    // from the selected country so old NOT NULL constraints don't break
    // the submission, instead of just passing null.
    let countryName = null, countryIsd = null;
    if (mandatory.Country_ID) {
      const cQ = await client.query(
        `SELECT ${qi('Country_Name')}, ${qi('Country_ISD')} FROM ${qi('Master')}.${qi('M_Country')} WHERE ${qi('Country_ID')} = $1`,
        [mandatory.Country_ID]
      );
      if (cQ.rowCount) { countryName = cQ.rows[0].Country_Name; countryIsd = cQ.rows[0].Country_ISD; }
    }

    const maxQ = await client.query(`SELECT COALESCE(MAX(${qi('Submission_ID')}), 0) + 1 AS next_id FROM ${qi('FMS')}.${qi('Form_Submission_Key_Details')}`);
    const submissionId = maxQ.rows[0].next_id;
    await client.query(
      `INSERT INTO ${qi('FMS')}.${qi('Form_Submission_Key_Details')}
        (${qi('Submission_ID')}, ${qi('Form_ID')}, ${qi('Sal')}, ${qi('First_Name')}, ${qi('Last_Name')}, ${qi('City')},
         ${qi('Country')}, ${qi('Country_ISD')}, ${qi('Country_ID')}, ${qi('WhatsApp_Number')}, ${qi('Email')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [submissionId, req.params.formId, mandatory.Sal || null, mandatory.First_Name, mandatory.Last_Name, mandatory.City,
       countryName, countryIsd, mandatory.Country_ID, mandatory.WhatsApp_Number, mandatory.Email]
    );

    if (additional && typeof additional === 'object') {
      const formIdNum = Number(req.params.formId);
      if (!Number.isInteger(formIdNum)) throw new Error('Invalid Form_ID for dynamic table');
      const defQ = await client.query(
        `SELECT ${qi('Question_Name')} FROM ${qi('FMS')}.${qi('Form_Additional_Fields')}
         WHERE ${qi('Form_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
        [req.params.formId]
      );
      const validQuestions = new Set(defQ.rows.map(r => r.Question_Name));
      const answered = Object.entries(additional).filter(([k, v]) => validQuestions.has(k) && v != null && v !== '');
      if (answered.length) {
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${qi('FMS')}.${qi('Form_ID_' + formIdNum + '_Details')} (
             "Submission_ID" BIGINT NOT NULL,
             "Question_Name" TEXT NOT NULL,
             "Answer_Value" TEXT,
             "Submitted_DT" TIMESTAMPTZ NOT NULL DEFAULT now()
           )`
        );
        for (const [question, value] of answered) {
          await client.query(
            `INSERT INTO ${qi('FMS')}.${qi('Form_ID_' + formIdNum + '_Details')} ("Submission_ID", "Question_Name", "Answer_Value")
             VALUES ($1,$2,$3)`,
            [submissionId, question, String(value)]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, submissionId });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /public/intake-form/:formId] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
