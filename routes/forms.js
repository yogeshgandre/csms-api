// routes/forms.js — Form Management System (FMS schema).
// Mirrors Satsang Management's shape: a definition with a Draft -> In
// Review -> Published lifecycle (routes/satsangs.js has the same pattern
// for M_Satsang), dynamic per-form fields (Form_Additional_Fields, same
// idea as M_Satsang_Defn), and per-department access config
// (Form_Seva_Dept_Access, same idea as Satsangs_Seva_Dept_Access) — not
// enforced anywhere yet, same as that one.
//
// This file is the staff-side definition/config tooling. The public,
// unauthenticated submission page (public/intake-form.html) is served by
// routes/public-forms.js and only accepts a form that's Published, unless
// a valid preview token (issued here, see /:id/preview-token) says
// otherwise — that's how "Preview" opens the real live page for a form in
// any other status. Curious Intake (routes/intake.js) reviews whatever
// submissions land in FMS.Form_Submission_Key_Details.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const previewTokens = require('../lib/formPreviewTokens');
const router = express.Router();

const FAR_FUTURE = '9999-12-31';

/* ============ Form_Creation_Process (definitions + lifecycle) ============
   Current_Status is bigint, not text — a real FK into Form_Status (same
   shape as Transfer_Status in Satsang Management), not a free string like
   M_Satsang's Satsang_Status. Looked up by name each time rather than
   hardcoding IDs, same reasoning as the Transfer_Status code. */

router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT fc.${qi('Form_ID')}, fc.${qi('Current_Status')}, fs.${qi('Form_Status_Name')}, fc.${qi('Current_Owner_CSMS_ID')},
              fc.${qi('Form_Published_URL')}, fc.${qi('Current_Status_Change_Date')}, fc.${qi('Form_Type_ID')}, fc.${qi('Form_Title')}, fc.${qi('Form_Desc')},
              mp.${qi('Platform_Name')},
              up.${qi('Seeker_Name')} AS owner_name
       FROM ${qi('FMS')}.${qi('Form_Creation_Process')} fc
       LEFT JOIN ${qi('FMS')}.${qi('Form_Status')} fs ON fs.${qi('Form_Status_ID')} = fc.${qi('Current_Status')}
       LEFT JOIN ${qi('FMS')}.${qi('Form_Type')} ft ON ft.${qi('Form_Type_ID')} = fc.${qi('Form_Type_ID')}
       LEFT JOIN ${qi('Master')}.${qi('M_Platform')} mp ON mp.${qi('Platform_ID')} = ft.${qi('Platform_ID')}
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = fc.${qi('Current_Owner_CSMS_ID')}
       ORDER BY fc.${qi('Current_Status_Change_Date')} DESC NULLS LAST, fc.${qi('Form_ID')} DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /forms] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

async function statusIdByName(name) {
  const q = await pool.query(`SELECT ${qi('Form_Status_ID')} FROM ${qi('FMS')}.${qi('Form_Status')} WHERE ${qi('Form_Status_Name')} = $1`, [name]);
  return q.rowCount ? q.rows[0].Form_Status_ID : null;
}

// Form_Type is a thin pointer to M_Platform (Form_Type_Name = that
// platform's Platform_Name, per instruction) — reused if a Form_Type row
// for this platform already exists, created on first use otherwise.
async function formTypeIdForPlatform(platformId) {
  const existing = await pool.query(
    `SELECT ${qi('Form_Type_ID')} FROM ${qi('FMS')}.${qi('Form_Type')} WHERE ${qi('Platform_ID')} = $1 LIMIT 1`,
    [platformId]
  );
  if (existing.rowCount) return existing.rows[0].Form_Type_ID;
  const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('Form_Type_ID')}), 0) + 1 AS next_id FROM ${qi('FMS')}.${qi('Form_Type')}`);
  const id = maxQ.rows[0].next_id;
  await pool.query(`INSERT INTO ${qi('FMS')}.${qi('Form_Type')} (${qi('Form_Type_ID')}, ${qi('Platform_ID')}) VALUES ($1,$2)`, [id, platformId]);
  return id;
}

router.post('/', requireAuth, async (req, res) => {
  const { platformId } = req.body || {};
  if (!platformId) return res.status(400).json({ error: 'platformId is required' });
  try {
    const draftId = await statusIdByName('Draft');
    if (!draftId) return res.status(500).json({ error: 'NO_STATUS_ROW', message: '"Draft" is missing from Form_Status — seed it first.' });
    const formTypeId = await formTypeIdForPlatform(platformId);
    const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('Form_ID')}), 0) + 1 AS next_id FROM ${qi('FMS')}.${qi('Form_Creation_Process')}`);
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('FMS')}.${qi('Form_Creation_Process')}
        (${qi('Form_ID')}, ${qi('Current_Status')}, ${qi('Current_Owner_CSMS_ID')}, ${qi('Current_Status_Change_Date')}, ${qi('Form_Type_ID')})
       VALUES ($1,$2,$3,CURRENT_DATE,$4)`,
      [id, draftId, req.user.csmsId, formTypeId]
    );
    res.status(201).json({ ok: true, formId: id });
  } catch (err) {
    console.error('[POST /forms] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

async function setFormStatus(req, res, fromNames, toName, extraSet, extraVals) {
  try {
    const toId = await statusIdByName(toName);
    if (!toId) return res.status(500).json({ error: 'NO_STATUS_ROW', message: `"${toName}" is missing from Form_Status — seed it first.` });

    const curQ = await pool.query(
      `SELECT fc.${qi('Current_Status')}, fs.${qi('Form_Status_Name')}
       FROM ${qi('FMS')}.${qi('Form_Creation_Process')} fc
       LEFT JOIN ${qi('FMS')}.${qi('Form_Status')} fs ON fs.${qi('Form_Status_ID')} = fc.${qi('Current_Status')}
       WHERE fc.${qi('Form_ID')} = $1`,
      [req.params.id]
    );
    if (curQ.rowCount === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!fromNames.includes(curQ.rows[0].Form_Status_Name)) {
      return res.status(409).json({ error: 'WRONG_STATUS', message: `Must be ${fromNames.join(' or ')} — currently ${curQ.rows[0].Form_Status_Name}.` });
    }
    const setClauses = [`${qi('Current_Status')} = $2`, `${qi('Current_Status_Change_Date')} = CURRENT_DATE`].concat(extraSet || []);
    await pool.query(
      `UPDATE ${qi('FMS')}.${qi('Form_Creation_Process')} SET ${setClauses.join(', ')} WHERE ${qi('Form_ID')} = $1`,
      [req.params.id, toId, ...(extraVals || [])]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[setFormStatus] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
}

router.post('/:id/submit-review', requireAuth, async (req, res) => {
  await setFormStatus(req, res, ['Draft'], 'In Review');
});
router.post('/:id/reject', requireAuth, async (req, res) => {
  await setFormStatus(req, res, ['In Review'], 'Draft');
});
// The app generates its own URL now (the frontend computes it from
// location.origin, same as the satsang self-service links) — no more
// asking staff to paste in an external link.
router.post('/:id/publish', requireAuth, async (req, res) => {
  const { publishedUrl } = req.body || {};
  if (!publishedUrl) return res.status(400).json({ error: 'publishedUrl is required to publish' });
  try {
    const consentQ = await pool.query(
      `SELECT 1 FROM ${qi('FMS')}.${qi('Form_Additional_Fields')}
       WHERE ${qi('Form_ID')} = $1 AND ${qi('Component_Type')} = 'CONSENT' AND ${qi('Ver_To_DT')} >= CURRENT_DATE LIMIT 1`,
      [req.params.id]
    );
    if (!consentQ.rowCount) {
      return res.status(400).json({ error: 'NO_CONSENT', message: 'Add at least one Consent field before publishing.' });
    }
  } catch (err) {
    console.error('[POST /forms/:id/publish consent check] error', err);
    return res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
  await setFormStatus(req, res, ['In Review'], 'Published', [`${qi('Form_Published_URL')} = $3`], [publishedUrl]);
});
router.post('/:id/pause', requireAuth, async (req, res) => {
  await setFormStatus(req, res, ['Published'], 'Paused');
});
router.post('/:id/resume', requireAuth, async (req, res) => {
  await setFormStatus(req, res, ['Paused'], 'Published');
});
router.post('/:id/archive', requireAuth, async (req, res) => {
  await setFormStatus(req, res, ['Published', 'Paused', 'Draft'], 'Archived');
});

/* ============ Form_Additional_Fields (dynamic questions per form) ============
   No PK or versioning was given in the schema — same situation
   M_Satsang_Defn was in; same fix (surrogate FAF_ID + Ver_From_DT/Ver_To_DT
   added via migration). */

// Issues a short-lived token so "Preview" can open the real public page
// (intake-form.html) for a form in ANY status, not just Published \u2014 see
// lib/formPreviewTokens.js and the GET /intake-form/:formId check in
// routes/public-forms.js that honours it.
router.post('/:id/preview-token', requireAuth, async (req, res) => {
  const token = previewTokens.issue(req.params.id);
  res.json({ token, expiresInSeconds: 600 });
});

// Form_Desc is a heading/purpose statement set once by the admin, shown to
// everyone who opens the public form \u2014 not stored per submission.
// Form_Title is the heading shown at the top of the public form. Form_Desc
// is the explanatory text underneath it — both set once by the admin, not
// stored per submission.
router.put('/:id/title', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('FMS')}.${qi('Form_Creation_Process')} SET ${qi('Form_Title')} = $1 WHERE ${qi('Form_ID')} = $2`,
      [(req.body || {}).title || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /forms/:id/title] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.put('/:id/desc', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('FMS')}.${qi('Form_Creation_Process')} SET ${qi('Form_Desc')} = $1 WHERE ${qi('Form_ID')} = $2`,
      [(req.body || {}).desc || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /forms/:id/desc] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.get('/:id/fields', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('FAF_ID')}, ${qi('Question_Name')}, ${qi('Question_Type')}, ${qi('Component_Type')}, ${qi('Question_Options')}
       FROM ${qi('FMS')}.${qi('Form_Additional_Fields')}
       WHERE ${qi('Form_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY ${qi('FAF_ID')}`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /forms/:id/fields] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

const QUESTION_TYPES = ['STRING', 'INTEGER', 'BOOLEAN', 'DATE'];
const COMPONENT_TYPES = ['INPUT', 'CHECKBOX', 'CONSENT', 'INFORMATION', 'WARNING', 'HIGHLIGHT'];

router.post('/:id/fields', requireAuth, async (req, res) => {
  const { questionName, questionType, componentType, questionOptions } = req.body || {};
  if (!questionName) return res.status(400).json({ error: 'questionName is required' });
  const qType = QUESTION_TYPES.includes(questionType) ? questionType : 'STRING';
  const cType = COMPONENT_TYPES.includes(componentType) ? componentType : 'INPUT';
  try {
    const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('FAF_ID')}), 0) + 1 AS next_id FROM ${qi('FMS')}.${qi('Form_Additional_Fields')}`);
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('FMS')}.${qi('Form_Additional_Fields')}
        (${qi('FAF_ID')}, ${qi('Form_ID')}, ${qi('Question_Name')}, ${qi('Question_Type')}, ${qi('Component_Type')}, ${qi('Question_Options')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7)`,
      [id, req.params.id, questionName, qType, cType, cType === 'CHECKBOX' ? (questionOptions || null) : null, FAR_FUTURE]
    );
    res.status(201).json({ ok: true, fafId: id });
  } catch (err) {
    console.error('[POST /forms/:id/fields] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.delete('/fields/:fafId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('FMS')}.${qi('Form_Additional_Fields')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day' WHERE ${qi('FAF_ID')} = $1`,
      [req.params.fafId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /forms/fields/:fafId] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ============ Form_Seva_Dept_Access (configuration only — not enforced
   anywhere yet, same as Satsangs_Seva_Dept_Access) ============ */

router.get('/access-config', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT fa.${qi('Form_Access_ID')}, fa.${qi('Form_Type_ID')}, fa.${qi('Seva_Dept_ID')},
              d.${qi('Seva_Dept_Name')},
              fa.${qi('Dept_Create_Role_ID')}, fa.${qi('Dept_Review_Role_ID')},
              fa.${qi('Dept_Approve_Role_ID')}, fa.${qi('Notify_Role_ID')}
       FROM ${qi('FMS')}.${qi('Form_Seva_Dept_Access')} fa
       LEFT JOIN ${qi('RMS')}.${qi('Seva_Dept')} d ON d.${qi('Seva_Dept_ID')} = fa.${qi('Seva_Dept_ID')}
       WHERE fa.${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY d.${qi('Seva_Dept_Name')}`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /forms/access-config] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/access-config', requireAuth, async (req, res) => {
  const { formTypeId, sevaDeptId, createRoleId, reviewRoleIds, approveRoleIds, notifyRoleIds } = req.body || {};
  if (!formTypeId || !sevaDeptId) return res.status(400).json({ error: 'formTypeId and sevaDeptId are required' });
  try {
    const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('Form_Access_ID')}), 0) + 1 AS next_id FROM ${qi('FMS')}.${qi('Form_Seva_Dept_Access')}`);
    const id = maxQ.rows[0].next_id;
    await pool.query(
      `INSERT INTO ${qi('FMS')}.${qi('Form_Seva_Dept_Access')}
        (${qi('Form_Access_ID')}, ${qi('Form_Type_ID')}, ${qi('Seva_Dept_ID')},
         ${qi('Dept_Create_Role_ID')}, ${qi('Dept_Review_Role_ID')}, ${qi('Dept_Approve_Role_ID')}, ${qi('Notify_Role_ID')},
         ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8)`,
      [id, formTypeId, sevaDeptId, createRoleId || null, reviewRoleIds || null, approveRoleIds || null, notifyRoleIds || null, FAR_FUTURE]
    );
    res.status(201).json({ ok: true, accessId: id });
  } catch (err) {
    console.error('[POST /forms/access-config] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.delete('/access-config/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('FMS')}.${qi('Form_Seva_Dept_Access')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day' WHERE ${qi('Form_Access_ID')} = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /forms/access-config/:id] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
