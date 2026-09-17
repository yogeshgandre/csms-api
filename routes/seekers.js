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
        `SELECT pe.*, p.${qi('Platform_Name')}
         FROM ${qi('MSR')}.${qi('Seeker_Platform_Engagement')} pe
         JOIN ${qi('Master')}.${qi('M_Platform')} p ON p.${qi('Platform_ID')} = pe.${qi('Platform_ID')}
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

module.exports = router;
