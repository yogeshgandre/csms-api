// routes/intake.js — Form_Submission_Key_Details -> promote/merge into Seeker.
//
// IMPORTANT: the dedup "match %" the prototype shows is entirely fake UI —
// there is no scoring algorithm defined anywhere, only Seeker_ID_Generator's
// columns (Input_Ref_ID, Email, Country_ISD, WhatsApp_Number). This endpoint
// does the one unambiguous check the schema actually supports — exact email
// or exact WhatsApp number match — and returns candidates. It does NOT
// invent a percentage score; that needs a real spec (fuzzy name matching?
// phonetic match? exact fields only?) before it can be built honestly.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// GET /api/intake — pending form submissions only.
// Form_Submission_Key_Details has no status/resolved column and no
// timestamp column at all — so "pending" is inferred: a submission counts
// as resolved once Seeker_ID_Generator has a row for it (written by
// promote/merge below), and is excluded here. Without this, every
// submission would show as pending forever, even after being promoted.
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fs.*, mp.${qi('Platform_Name')}, mp.${qi('Is_Form')}, mc.${qi('Country_Name')}
       FROM ${qi('FMS')}.${qi('Form_Submission_Key_Details')} fs
       LEFT JOIN ${qi('FMS')}.${qi('Form_Type')} ft ON ft.${qi('Form_Type_ID')} = fs.${qi('Form_ID')}
       LEFT JOIN ${qi('Master')}.${qi('M_Platform')} mp ON mp.${qi('Platform_ID')} = ft.${qi('Platform_ID')}
       LEFT JOIN ${qi('Master')}.${qi('M_Country')} mc ON mc.${qi('Country_ID')} = fs.${qi('Country_ID')}
       WHERE NOT EXISTS (
         SELECT 1 FROM ${qi('MSR')}.${qi('Seeker_ID_Generator')} sig
         WHERE sig.${qi('Input_Ref_ID')} = fs.${qi('Submission_ID')}
       )
       ORDER BY fs.${qi('Submission_ID')} DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /intake] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/intake/:id/candidates — exact-match dedup only (see note above)
router.get('/:id/candidates', requireAuth, async (req, res) => {
  try {
    const sub = await pool.query(
      `SELECT fs.*, mc.${qi('Country_Name')}
       FROM ${qi('FMS')}.${qi('Form_Submission_Key_Details')} fs
       LEFT JOIN ${qi('Master')}.${qi('M_Country')} mc ON mc.${qi('Country_ID')} = fs.${qi('Country_ID')}
       WHERE fs.${qi('Submission_ID')} = $1`,
      [req.params.id]
    );
    if (sub.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    const s = sub.rows[0];

    const candidates = await pool.query(
      `SELECT ${qi('Seeker_ID')}, ${qi('First_Name')}, ${qi('Last_Name')}, ${qi('Email')}, ${qi('WhatsApp_Number')}
       FROM ${qi('MSR')}.${qi('Seeker')}
       WHERE lower(${qi('Email')}) = lower($1) OR ${qi('WhatsApp_Number')} = $2`,
      [s.Email, s.WhatsApp_Number]
    );

    // Answers to this form's own Form_Additional_Fields questions, if any —
    // lives in a dynamic per-form table (Form_ID_<N>_Details) that only
    // exists once that form actually has additional fields defined and
    // something has written to it; nothing writes to it yet (no public
    // submission page has been built), so this is read-defensively.
    let additionalAnswers = [];
    try {
      const ansQ = await pool.query(
        `SELECT * FROM ${qi('FMS')}.${qi('Form_ID_' + s.Form_ID + '_Details')} WHERE ${qi('Submission_ID')} = $1`,
        [req.params.id]
      );
      additionalAnswers = ansQ.rows;
    } catch (e) { /* table doesn't exist for this form yet — fine, just no extra answers */ }

    res.json({ submission: s, candidates: candidates.rows, additionalAnswers });
  } catch (err) {
    console.error('[GET /intake/:id/candidates] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// PUT /api/intake/:id/country — corrects/sets the submission's Country_ID
// before promoting. Needed because no public form exists yet to run the
// M_Country autocomplete on at entry time — this is the one place a
// reviewer can fix a missing or wrong country before it becomes a seeker.
router.put('/:id/country', requireAuth, async (req, res) => {
  const { countryId } = req.body || {};
  if (!countryId) return res.status(400).json({ error: 'countryId is required' });
  try {
    await pool.query(
      `UPDATE ${qi('FMS')}.${qi('Form_Submission_Key_Details')} SET ${qi('Country_ID')} = $2 WHERE ${qi('Submission_ID')} = $1`,
      [req.params.id, countryId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /intake/:id/country] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// POST /api/intake/:id/promote — create a new Seeker from this submission
router.post('/:id/promote', requireAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const sub = await client.query(
      `SELECT fs.*, mc.${qi('Country_ISD')} AS country_isd_from_fk
       FROM ${qi('FMS')}.${qi('Form_Submission_Key_Details')} fs
       LEFT JOIN ${qi('Master')}.${qi('M_Country')} mc ON mc.${qi('Country_ID')} = fs.${qi('Country_ID')}
       WHERE fs.${qi('Submission_ID')} = $1`,
      [req.params.id]
    );
    if (sub.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    const s = sub.rows[0];
    // Prefer the ISD code from the confirmed M_Country FK over the
    // submission's own free-entry Country_ISD, since the FK is the
    // reviewed/correct value once Country_ID has been set.
    const countryIsd = s.country_isd_from_fk != null ? s.country_isd_from_fk : s.Country_ISD;

    const inserted = await client.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker')}
        (${qi('Sal')}, ${qi('First_Name')}, ${qi('Last_Name')}, ${qi('City')},
         ${qi('Country_ISD')}, ${qi('WhatsApp_Number')}, ${qi('Email')})
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${qi('Seeker_ID')}`,
      [s.Sal, s.First_Name, s.Last_Name, s.City, countryIsd, s.WhatsApp_Number, s.Email]
    );

    await client.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker_ID_Generator')}
        (${qi('Input_Ref_ID')}, ${qi('Input_Type_ID')}, ${qi('Seeker_ID')}, ${qi('Email')}, ${qi('Country_ISD')}, ${qi('WhatsApp_Number')})
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.Submission_ID, 1 /* TODO: real Input_Type_ID for "form submission" — no lookup table for this was provided */,
       inserted.rows[0].Seeker_ID, s.Email, s.Country_ISD, s.WhatsApp_Number]
    );

    await client.query('COMMIT');
    res.json({ seekerId: inserted.rows[0].Seeker_ID });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /intake/:id/promote] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  } finally {
    if (client) client.release();
  }
});

// POST /api/intake/:id/merge — link this submission to an existing Seeker
router.post('/:id/merge', requireAuth, async (req, res) => {
  const { seekerId } = req.body || {};
  if (!seekerId) return res.status(400).json({ error: 'seekerId is required' });
  try {
    const sub = await pool.query(
      `SELECT * FROM ${qi('FMS')}.${qi('Form_Submission_Key_Details')} WHERE ${qi('Submission_ID')} = $1`,
      [req.params.id]
    );
    if (sub.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    const s = sub.rows[0];

    await pool.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker_ID_Generator')}
        (${qi('Input_Ref_ID')}, ${qi('Input_Type_ID')}, ${qi('Seeker_ID')}, ${qi('Email')}, ${qi('Country_ISD')}, ${qi('WhatsApp_Number')})
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.Submission_ID, 1, seekerId, s.Email, s.Country_ISD, s.WhatsApp_Number]
    );
    res.json({ ok: true, seekerId });
  } catch (err) {
    console.error('[POST /intake/:id/merge] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
