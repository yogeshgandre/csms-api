// routes/seekers.js
//
// Wraps MSR.Seeker and its satellite tables. Region scoping: dept -> region
// mapping isn't in the schema you shared (Seva_Dept has no Region_ID column),
// so for now this filters by Country only, via M_Country. If Seva_Dept is
// meant to carry a region, that column needs adding before scoping is exact.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// GET /api/seekers?country=Germany&q=anja
router.get('/', requireAuth, async (req, res) => {
  const { country, q } = req.query;
  const clauses = [];
  const params = [];

  if (country) {
    params.push(country);
    clauses.push(`s.${qi('Country_ID')} = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    clauses.push(
      `(s.${qi('First_Name')} ILIKE $${params.length} OR s.${qi('Last_Name')} ILIKE $${params.length} OR s.${qi('Email')} ILIKE $${params.length})`
    );
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT s.${qi('Seeker_ID')}, s.${qi('Sal')}, s.${qi('First_Name')}, s.${qi('Last_Name')},
              s.${qi('City')}, s.${qi('Country_ID')}, mc.${qi('Country_Name')},
              s.${qi('Email')}, s.${qi('WhatsApp_Number')},
              s.${qi('Country_ISD')}, s.${qi('Ref_Seeker_ID')},
              cat.${qi('Category_Name')},
              ml.${qi('Weekly_Seva_Hrs')}, ml.${qi('Pranshakti')}, ml.${qi('Sensitive_List')}
       FROM ${qi('MSR')}.${qi('Seeker')} s
       LEFT JOIN ${qi('Master')}.${qi('M_Country')} mc ON mc.${qi('Country_ID')} = s.${qi('Country_ID')}
       LEFT JOIN ${qi('MSR')}.${qi('Seeker_Category')} sc
         ON sc.${qi('Seeker_ID')} = s.${qi('Seeker_ID')} AND sc.${qi('Ver_To_DT')} >= CURRENT_DATE
       LEFT JOIN ${qi('Master')}.${qi('M_Seeker_Category')} cat
         ON cat.${qi('Category_ID')} = sc.${qi('Seeker_Category_ID')}
       LEFT JOIN ${qi('MSR')}.${qi('Seeker_Other_MasterList_Info')} ml
         ON ml.${qi('Seeker_ID')} = s.${qi('Seeker_ID')} AND ml.${qi('Ver_To_DT')} >= CURRENT_DATE
       ${where}
       ORDER BY s.${qi('First_Name')}, s.${qi('Last_Name')}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /seekers] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/seekers/:id — full profile for the drawer
router.get('/:id', requireAuth, async (req, res) => {
  const seekerId = req.params.id;
  try {
    const [seeker, categories, engagements, bhav, upay, vyashti] = await Promise.all([
      pool.query(
        `SELECT * FROM ${qi('MSR')}.${qi('Seeker')} WHERE ${qi('Seeker_ID')} = $1`,
        [seekerId]
      ),
      pool.query(
        `SELECT cat.${qi('Category_Name')}, sc.${qi('Ver_From_DT')}, sc.${qi('Ver_To_DT')}
         FROM ${qi('MSR')}.${qi('Seeker_Category')} sc
         JOIN ${qi('Master')}.${qi('M_Seeker_Category')} cat ON cat.${qi('Category_ID')} = sc.${qi('Seeker_Category_ID')}
         WHERE sc.${qi('Seeker_ID')} = $1 ORDER BY sc.${qi('Ver_From_DT')} DESC`,
        [seekerId]
      ),
      pool.query(
        `SELECT pe.*, p.${qi('Platform_Name')}, up.${qi('Seeker_Name')} AS "LoggedByName"
         FROM ${qi('MSR')}.${qi('Seeker_Platform_Engagement')} pe
         JOIN ${qi('Master')}.${qi('M_Platform')} p ON p.${qi('Platform_ID')} = pe.${qi('Platform_ID')}
         LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = pe.${qi('Contacting_Seeker_ID')}
         WHERE pe.${qi('Seeker_ID')} = $1 ORDER BY pe.${qi('Engagement_DT')} DESC`,
        [seekerId]
      ),
      pool.query(`SELECT * FROM ${qi('MSR')}.${qi('Seeker_Bhav_Satsang')} WHERE ${qi('Seeker_ID')} = $1`, [seekerId]),
      pool.query(`SELECT * FROM ${qi('MSR')}.${qi('Seeker_Upay_Satsang')} WHERE ${qi('Seeker_ID')} = $1`, [seekerId]),
      pool.query(`SELECT * FROM ${qi('MSR')}.${qi('Seeker_Vyashti_Satsang')} WHERE ${qi('Seeker_ID')} = $1`, [seekerId]),
    ]);

    if (seeker.rowCount === 0) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    res.json({
      ...seeker.rows[0],
      categories: categories.rows,
      platformEngagements: engagements.rows,
      satsangs: { bhav: bhav.rows, upay: upay.rows, vyashti: vyashti.rows },
    });
  } catch (err) {
    console.error('[GET /seekers/:id] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// PUT /api/seekers/:id/category — moves a seeker to a new category (drag
// between Journey lanes). Closes the current active Seeker_Category row
// and opens a new one, same versioning pattern used everywhere else.
router.put('/:id/category', requireAuth, async (req, res) => {
  const { categoryId } = req.body || {};
  if (!categoryId) return res.status(400).json({ error: 'categoryId is required' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `UPDATE ${qi('MSR')}.${qi('Seeker_Category')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Seeker_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [req.params.id]
    );
    await client.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker_Category')} (${qi('Seeker_ID')}, ${qi('Seeker_Category_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, CURRENT_DATE, '9999-12-31')`,
      [req.params.id, categoryId]
    );
    // Mirror the category change into the Journey milestone table so it
    // shows up on the seeker's timeline, not just as the current category.
    const catQ = await client.query(
      `SELECT ${qi('Category_Name')} FROM ${qi('Master')}.${qi('M_Seeker_Category')} WHERE ${qi('Category_ID')} = $1`,
      [categoryId]
    );
    const catName = catQ.rows[0] ? catQ.rows[0].Category_Name : null;
    const maxQ = await client.query(`SELECT COALESCE(MAX(${qi('Milestone_ID')}), 0) + 1 AS next_id FROM ${qi('MSR')}.${qi('Seeker_Milestone')}`);
    await client.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker_Milestone')} (${qi('Milestone_ID')}, ${qi('Seeker_ID')}, ${qi('Milestone_Kind')}, ${qi('Milestone_Label')}, ${qi('Milestone_DT')}, ${qi('Created_ID')})
       VALUES ($1,$2,$3,$4,CURRENT_DATE,$5)`,
      [maxQ.rows[0].next_id, req.params.id, 'Category', `Moved to ${catName || 'category #' + categoryId}`, req.user.csmsId]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[PUT /seekers/:id/category] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

// PUT /api/seekers/:id/details — edits the base MSR.Seeker fields that
// are safe to correct after entry (address, alternate contacts, referral).
// Email, WhatsApp, City and Country are intentionally excluded — those
// come from the seeker's original entry and aren't edited here.
const EDITABLE_DETAIL_FIELDS = ['State', 'Address_Line1', 'Address_Line2', 'Postal_Code', 'Viber_Number', 'Skype_ID', 'Ref_Seeker_ID', 'Birth_Year'];
router.put('/:id/details', requireAuth, async (req, res) => {
  const { field, value } = req.body || {};
  if (!EDITABLE_DETAIL_FIELDS.includes(field)) return res.status(400).json({ error: 'INVALID_FIELD' });
  try {
    await pool.query(
      `UPDATE ${qi('MSR')}.${qi('Seeker')} SET ${qi(field)} = $2 WHERE ${qi('Seeker_ID')} = $1`,
      [req.params.id, value === '' ? null : value]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /seekers/:id/details] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

// GET/POST /api/seekers/:id/milestones — MSR.Seeker_Milestone
router.get('/:id/milestones', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM ${qi('MSR')}.${qi('Seeker_Milestone')} WHERE ${qi('Seeker_ID')} = $1 ORDER BY ${qi('Milestone_DT')} DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /seekers/:id/milestones] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});
router.post('/:id/milestones', requireAuth, async (req, res) => {
  const { kind, label } = req.body || {};
  if (!kind || !label) return res.status(400).json({ error: 'kind and label are required' });
  try {
    const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('Milestone_ID')}), 0) + 1 AS next_id FROM ${qi('MSR')}.${qi('Seeker_Milestone')}`);
    await pool.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker_Milestone')} (${qi('Milestone_ID')}, ${qi('Seeker_ID')}, ${qi('Milestone_Kind')}, ${qi('Milestone_Label')}, ${qi('Milestone_DT')}, ${qi('Created_ID')})
       VALUES ($1,$2,$3,$4,CURRENT_DATE,$5)`,
      [maxQ.rows[0].next_id, req.params.id, kind, label, req.user.csmsId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /seekers/:id/milestones] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

// GET/POST /api/seekers/:id/internal-notes — MSR.Seeker_Internal_Notes.
// Private to staff, deliberately separate from Platform Engagements
// (which is the seeker-facing interaction record).
router.get('/:id/internal-notes', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT n.*, up.${qi('Seeker_Name')} AS "AuthorName"
       FROM ${qi('MSR')}.${qi('Seeker_Internal_Notes')} n
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = n.${qi('Created_ID')}
       WHERE n.${qi('Seeker_ID')} = $1 ORDER BY n.${qi('Creation_DT')} DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /seekers/:id/internal-notes] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});
router.post('/:id/internal-notes', requireAuth, async (req, res) => {
  const { noteText } = req.body || {};
  if (!noteText || !noteText.trim()) return res.status(400).json({ error: 'noteText is required' });
  try {
    const maxQ = await pool.query(`SELECT COALESCE(MAX(${qi('Note_ID')}), 0) + 1 AS next_id FROM ${qi('MSR')}.${qi('Seeker_Internal_Notes')}`);
    await pool.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker_Internal_Notes')} (${qi('Note_ID')}, ${qi('Seeker_ID')}, ${qi('Note_Text')}, ${qi('Created_ID')})
       VALUES ($1,$2,$3,$4)`,
      [maxQ.rows[0].next_id, req.params.id, noteText.trim(), req.user.csmsId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /seekers/:id/internal-notes] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

// GET /api/seekers/:id/masterlist — current active Seeker_Other_MasterList_Info row (or null)
router.get('/:id/masterlist', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM ${qi('MSR')}.${qi('Seeker_Other_MasterList_Info')}
       WHERE ${qi('Seeker_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE
       ORDER BY ${qi('Creation_DT')} DESC LIMIT 1`,
      [req.params.id]
    );
    res.json(r.rowCount ? r.rows[0] : null);
  } catch (err) {
    console.error('[GET /seekers/:id/masterlist] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// PUT /api/seekers/:id/masterlist — versioned upsert: closes the current
// active row (if any) and inserts a fresh full snapshot. Body carries all
// nine editable fields; send the current values for anything unchanged —
// this isn't a partial patch.
router.put('/:id/masterlist', requireAuth, async (req, res) => {
  const {
    pranshakti, subRegion, sadhanaStartDt, weeklySevaHrs, perInfo,
    oppHome, visitedAshram, attendedMavWorkshop, sensitiveList, availability,
  } = req.body || {};
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `UPDATE ${qi('MSR')}.${qi('Seeker_Other_MasterList_Info')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Seeker_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [req.params.id]
    );
    await client.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker_Other_MasterList_Info')}
        (${qi('Seeker_ID')}, ${qi('Pranshakti')}, ${qi('Sub_Region')}, ${qi('Sadhana_ST_DT')}, ${qi('Weekly_Seva_Hrs')},
         ${qi('Per_Info')}, ${qi('Opp_Home')}, ${qi('Visited_Ashram')}, ${qi('Attended_MAV_Workshop')}, ${qi('Sensitive_List')}, ${qi('Availability')},
         ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')}, ${qi('Created_ID')}, ${qi('Creation_DT')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_DATE,'9999-12-31',$12,now())`,
      [req.params.id, pranshakti || null, subRegion || null, sadhanaStartDt || null, weeklySevaHrs || null,
       perInfo || null, oppHome || null, visitedAshram || null, attendedMavWorkshop || null, sensitiveList || null, availability || null,
       req.user.csmsId]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[PUT /seekers/:id/masterlist] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  } finally {
    if (client) client.release();
  }
});

// ---- Satsang links (Seeker_Upay_Satsang / Seeker_Vyashti_Satsang / Seeker_Bhav_Satsang) ----
// Same shape across all three: Seeker_ID, Satsang_ID, Ver_From_DT, Ver_To_DT,
// no surrogate PK — a seeker can't have the same satsang linked twice while
// both rows are active, so the natural key is enough (matches the
// Satsang_Conductor / Satsang_Attending_Seekers pattern already used).
const SATSANG_LINK_TABLES = { upay: 'Seeker_Upay_Satsang', vyashti: 'Seeker_Vyashti_Satsang', bhav: 'Seeker_Bhav_Satsang' };

router.get('/:id/satsang-links', requireAuth, async (req, res) => {
  try {
    const out = {};
    for (const [key, table] of Object.entries(SATSANG_LINK_TABLES)) {
      const r = await pool.query(
        `SELECT sl.${qi('Satsang_ID')}, ms.${qi('Satsang_Name')}
         FROM ${qi('MSR')}.${qi(table)} sl
         LEFT JOIN ${qi('SCS')}.${qi('M_Satsang')} ms ON ms.${qi('Satsang_ID')} = sl.${qi('Satsang_ID')}
         WHERE sl.${qi('Seeker_ID')} = $1 AND sl.${qi('Ver_To_DT')} >= CURRENT_DATE`,
        [req.params.id]
      );
      out[key] = r.rows;
    }
    res.json(out);
  } catch (err) {
    console.error('[GET /seekers/:id/satsang-links] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/:id/satsang-links', requireAuth, async (req, res) => {
  const { type, satsangId } = req.body || {};
  const table = SATSANG_LINK_TABLES[type];
  if (!table || !satsangId) return res.status(400).json({ error: 'type (upay|vyashti|bhav) and satsangId are required' });
  try {
    await pool.query(
      `INSERT INTO ${qi('MSR')}.${qi(table)} (${qi('Seeker_ID')}, ${qi('Satsang_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       SELECT $1, $2, CURRENT_DATE, '9999-12-31'
       WHERE NOT EXISTS (
         SELECT 1 FROM ${qi('MSR')}.${qi(table)}
         WHERE ${qi('Seeker_ID')} = $1 AND ${qi('Satsang_ID')} = $2 AND ${qi('Ver_To_DT')} >= CURRENT_DATE
       )`,
      [req.params.id, satsangId]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[POST /seekers/:id/satsang-links] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.delete('/:id/satsang-links/:type/:satsangId', requireAuth, async (req, res) => {
  const table = SATSANG_LINK_TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Unknown link type' });
  try {
    await pool.query(
      `UPDATE ${qi('MSR')}.${qi(table)} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Seeker_ID')} = $1 AND ${qi('Satsang_ID')} = $2 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [req.params.id, req.params.satsangId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /seekers/:id/satsang-links] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/seekers/:id/comments — every Satsang_Comments entry for this
// seeker across all their events (unlike the event-scoped one in
// satsangs.js), so it can surface on the seeker's own detail view —
// reachable from a Journey card, not just from inside one event.
router.get('/:id/comments', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.${qi('Comment_ID')}, c.${qi('SE_ID')}, c.${qi('Comments')}, c.${qi('Comments_Date')},
              up.${qi('Seeker_Name')} AS conductor_name, ms.${qi('Satsang_Name')}, se.${qi('Event_ST_DT_TIME')}
       FROM ${qi('SCS')}.${qi('Satsang_Seeker_Comments')} c
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = c.${qi('SC_CSMS_ID')}
       LEFT JOIN ${qi('SCS')}.${qi('Satsang_Event_Defn')} se ON se.${qi('SE_ID')} = c.${qi('SE_ID')}
       LEFT JOIN ${qi('SCS')}.${qi('M_Satsang')} ms ON ms.${qi('Satsang_ID')} = se.${qi('Satsang_ID')}
       WHERE c.${qi('Seeker_ID')} = $1
       ORDER BY c.${qi('Comments_Date')} DESC, c.${qi('Comment_ID')} DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /seekers/:id/comments] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// ---- Seeker Skills (SMS.Skills + MSR.Seeker_Skills) ----

router.get('/:id/skills', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sk.${qi('Skill_ID')}, s.${qi('Skill_Name')}, sk.${qi('Skill_Proficiency')}
       FROM ${qi('MSR')}.${qi('Seeker_Skills')} sk
       LEFT JOIN ${qi('SMS')}.${qi('Skills')} s ON s.${qi('Skill_ID')} = sk.${qi('Skill_ID')}
       WHERE sk.${qi('Seeker_ID')} = $1
       ORDER BY s.${qi('Skill_Name')}`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /seekers/:id/skills] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

const SKILL_PROFICIENCIES = ['High', 'Medium', 'Low'];

// Upsert — re-adding a skill with a new proficiency updates it, rather
// than needing a separate edit path. (Seeker_ID, Skill_ID) is the real PK.
router.post('/:id/skills', requireAuth, async (req, res) => {
  const { skillId, proficiency } = req.body || {};
  if (!skillId || !SKILL_PROFICIENCIES.includes(proficiency)) {
    return res.status(400).json({ error: 'skillId and a valid proficiency (High/Medium/Low) are required' });
  }
  try {
    await pool.query(
      `INSERT INTO ${qi('MSR')}.${qi('Seeker_Skills')} (${qi('Seeker_ID')}, ${qi('Skill_ID')}, ${qi('Skill_Proficiency')})
       VALUES ($1,$2,$3)
       ON CONFLICT (${qi('Seeker_ID')}, ${qi('Skill_ID')}) DO UPDATE SET ${qi('Skill_Proficiency')} = EXCLUDED.${qi('Skill_Proficiency')}`,
      [req.params.id, skillId, proficiency]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[POST /seekers/:id/skills] error', err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

router.delete('/:id/skills/:skillId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM ${qi('MSR')}.${qi('Seeker_Skills')} WHERE ${qi('Seeker_ID')} = $1 AND ${qi('Skill_ID')} = $2`,
      [req.params.id, req.params.skillId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /seekers/:id/skills/:skillId] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
