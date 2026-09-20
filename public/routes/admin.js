// routes/admin.js — Seva_Dept / Seva_Dept_Role / Seva_Dept_Role_HRCHY management.
//
// Versioning convention (per project decisions log — NOT "IS NULL"):
//   insert:  Ver_From_DT = CURRENT_DATE, Ver_To_DT = '9999-12-31'
//   update:  supersede the old row (its Ver_To_DT -> yesterday), insert new
//
// AUTHORIZATION WARNING: these are structural/destructive endpoints —
// creating departments, creating roles, rewriting hierarchy — gated only by
// requireAuth (any signed-in CSMS user with at least one active role
// anywhere). There is no separate "admin" privilege concept anywhere in the
// schema you provided, so none is enforced here. Any invited user can
// currently create departments and roles. Flagging this loudly rather than
// letting the endpoint names imply a safety that isn't there — if only
// specific people should manage structure, that needs a real admin flag
// (on User_Profile? a reserved Dept_Role_Name convention?) before this goes
// near production.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const FAR_FUTURE = '9999-12-31';

// POST /api/admin/depts — create a Seva Department
router.post('/depts', requireAuth, async (req, res) => {
  const { name, parentId } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO ${qi('RMS')}.${qi('Seva_Dept')}
        (${qi('Seva_Dept_Name')}, ${qi('Parent_Seva_Dept_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, CURRENT_DATE, $3)
       RETURNING ${qi('Seva_Dept_ID')}`,
      [name, parentId || null, FAR_FUTURE]
    );
    res.status(201).json({ sevaDeptId: result.rows[0].Seva_Dept_ID });
  } catch (err) {
    console.error('[POST /admin/depts] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/admin/depts/:id/roles — roles in a dept, with current hierarchy
// rank and who currently holds each one (name + the USDR_ID needed to
// remove that specific assignment).
router.get('/depts/:id/roles', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.${qi('Dept_Role_ID')}, r.${qi('Dept_Role_Name')}, r.${qi('Dept_Role_Desc')},
              h.${qi('HRCHY_ID')},
              COALESCE(
                json_agg(json_build_object(
                  'name', up.${qi('Seeker_Name')}, 'usdrId', usdr.${qi('USDR_ID')},
                  'csmsId', up.${qi('CSMS_ID')}, 'email', up.${qi('Seeker_Email')}
                ))
                  FILTER (WHERE up.${qi('Seeker_Name')} IS NOT NULL),
                '[]'
              ) AS holders
       FROM ${qi('RMS')}.${qi('Seva_Dept_Role')} r
       LEFT JOIN ${qi('RMS')}.${qi('Seva_Dept_Role_HRCHY')} h
         ON h.${qi('Dept_Role_ID')} = r.${qi('Dept_Role_ID')}
         AND h.${qi('Seva_Dept_ID')} = r.${qi('Seva_Dept_ID')}
         AND h.${qi('Ver_To_DT')} >= CURRENT_DATE
       LEFT JOIN ${qi('RMS')}.${qi('User_Seva_Dept_Role')} usdr
         ON usdr.${qi('Dept_Role_ID')} = r.${qi('Dept_Role_ID')}
         AND usdr.${qi('Seva_Dept_ID')} = r.${qi('Seva_Dept_ID')}
         AND (usdr.${qi('Ver_To_DT')} IS NULL OR usdr.${qi('Ver_To_DT')} >= CURRENT_DATE)
       LEFT JOIN ${qi('RMS')}.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = usdr.${qi('CSMS_ID')}
       WHERE r.${qi('Seva_Dept_ID')} = $1 AND r.${qi('Ver_To_DT')} >= CURRENT_DATE
       GROUP BY r.${qi('Dept_Role_ID')}, r.${qi('Dept_Role_Name')}, r.${qi('Dept_Role_Desc')}, h.${qi('HRCHY_ID')}
       ORDER BY h.${qi('HRCHY_ID')} NULLS LAST, r.${qi('Dept_Role_Name')}`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /admin/depts/:id/roles] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// POST /api/admin/roles — create a role within a department.
// Dept_Role_ID has no auto-increment/sequence on this table (confirmed by a
// NULL-PK insert failure) — unlike Seva_Dept_ID, which does. The next ID is
// computed explicitly (MAX+1) and retried on collision: a plain MAX+1 has a
// real race window if two requests land close together (confirmed — this
// happened on the first deploy of the fix), so this wraps it in a
// retry-on-unique-violation loop rather than trusting one read to be safe.
router.post('/roles', requireAuth, async (req, res) => {
  const { sevaDeptId, name, desc } = req.body || {};
  if (!sevaDeptId || !name) {
    return res.status(400).json({ error: 'sevaDeptId and name are required' });
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const maxQ = await client.query(
        `SELECT COALESCE(MAX(${qi('Dept_Role_ID')}), 0) + 1 AS next_id
         FROM ${qi('RMS')}.${qi('Seva_Dept_Role')}`
      );
      const nextId = maxQ.rows[0].next_id;

      const result = await client.query(
        `INSERT INTO ${qi('RMS')}.${qi('Seva_Dept_Role')}
          (${qi('Dept_Role_ID')}, ${qi('Seva_Dept_ID')}, ${qi('Dept_Role_Name')}, ${qi('Dept_Role_Desc')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
         VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
         RETURNING ${qi('Dept_Role_ID')}`,
        [nextId, sevaDeptId, name, desc || '', FAR_FUTURE]
      );

      await client.query('COMMIT');
      return res.status(201).json({ deptRoleId: result.rows[0].Dept_Role_ID });
    } catch (err) {
      if (client) await client.query('ROLLBACK');
      if (err.code === '23505' && attempt < MAX_ATTEMPTS) {
        // Unique violation — someone else took that ID between our read and
        // our insert. Retry with a fresh MAX+1 rather than failing the user.
        continue;
      }
      console.error('[POST /admin/roles] error', err);
      return res.status(500).json({ error: 'INTERNAL' });
    } finally {
      if (client) client.release();
    }
  }
});

// POST /api/admin/hierarchy — set (or change) a role's rank within its dept.
// Supersedes any existing active row for this (dept, role) pair rather than
// leaving two "active" rows around, per the versioning convention.
router.post('/hierarchy', requireAuth, async (req, res) => {
  const { sevaDeptId, deptRoleId, hrchyId } = req.body || {};
  if (!sevaDeptId || !deptRoleId || hrchyId == null) {
    return res.status(400).json({ error: 'sevaDeptId, deptRoleId and hrchyId are required' });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    await client.query(
      `UPDATE ${qi('RMS')}.${qi('Seva_Dept_Role_HRCHY')}
       SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Seva_Dept_ID')} = $1 AND ${qi('Dept_Role_ID')} = $2
         AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [sevaDeptId, deptRoleId]
    );

    await client.query(
      `INSERT INTO ${qi('RMS')}.${qi('Seva_Dept_Role_HRCHY')}
        (${qi('Seva_Dept_ID')}, ${qi('Dept_Role_ID')}, ${qi('HRCHY_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
       VALUES ($1, $2, $3, CURRENT_DATE, $4)`,
      [sevaDeptId, deptRoleId, hrchyId, FAR_FUTURE]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[POST /admin/hierarchy] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  } finally {
    if (client) client.release();
  }
});

// POST /api/admin/assign-role — put a CSMS user into a dept/role.
// If no User_Profile exists yet for this email (they've never signed in),
// one is created here so assignment isn't blocked on a prior login —
// CSMS_ID is generated with the same MAX+1-with-retry approach already
// used for Dept_Role_ID above, since this schema doesn't give every ID
// column a real sequence. This insert sets only CSMS_ID/Seeker_Email/
// Seeker_Name — confirmed by testing that User_Profile, unlike most tables
// here, has no Ver_From_DT/Ver_To_DT (it isn't versioned). If it turns out
// to have other required columns not yet seen, this fails with a clear
// Postgres error rather than corrupting anything.
router.post('/assign-role', requireAuth, async (req, res) => {
  const { email, sevaDeptId, deptRoleId, name } = req.body || {};
  if (!email || !sevaDeptId || !deptRoleId) {
    return res.status(400).json({ error: 'email, sevaDeptId and deptRoleId are required' });
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      let csmsId, personName, profileCreated = false;
      const userQ = await client.query(
        `SELECT ${qi('CSMS_ID')}, ${qi('Seeker_Name')} FROM ${qi('RMS')}.${qi('User_Profile')}
         WHERE lower(${qi('Seeker_Email')}) = lower($1) LIMIT 1`,
        [email]
      );

      if (userQ.rowCount > 0) {
        csmsId = userQ.rows[0].CSMS_ID;
        personName = userQ.rows[0].Seeker_Name;
      } else {
        const maxQ = await client.query(
          `SELECT COALESCE(MAX(${qi('CSMS_ID')}), 0) + 1 AS next_id FROM ${qi('RMS')}.${qi('User_Profile')}`
        );
        csmsId = maxQ.rows[0].next_id;
        personName = (name && name.trim()) || email.split('@')[0];
        // Confirmed by testing: User_Profile has no Ver_From_DT/Ver_To_DT —
        // unlike most tables in this schema, it isn't versioned.
        const insQ = await client.query(
          `INSERT INTO ${qi('RMS')}.${qi('User_Profile')}
            (${qi('CSMS_ID')}, ${qi('Seeker_Email')}, ${qi('Seeker_Name')})
           VALUES ($1, $2, $3)
           RETURNING ${qi('CSMS_ID')}`,
          [csmsId, email, personName]
        );
        csmsId = insQ.rows[0].CSMS_ID;
        profileCreated = true;
      }

      // Supersede any existing active assignment for this person IN THIS SAME
      // department (a person can hold roles in more than one department —
      // this only replaces a prior role within the one department given).
      await client.query(
        `UPDATE ${qi('RMS')}.${qi('User_Seva_Dept_Role')}
         SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
         WHERE ${qi('CSMS_ID')} = $1 AND ${qi('Seva_Dept_ID')} = $2
           AND (${qi('Ver_To_DT')} IS NULL OR ${qi('Ver_To_DT')} >= CURRENT_DATE)`,
        [csmsId, sevaDeptId]
      );

      // USDR_ID has no sequence either — same MAX+1 pattern as CSMS_ID and
      // Dept_Role_ID above. Confirmed by testing: without this, USDR_ID
      // inserts as NULL and fails the primary key's NOT NULL constraint.
      const usdrMaxQ = await client.query(
        `SELECT COALESCE(MAX(${qi('USDR_ID')}), 0) + 1 AS next_id FROM ${qi('RMS')}.${qi('User_Seva_Dept_Role')}`
      );
      const usdrId = usdrMaxQ.rows[0].next_id;

      await client.query(
        `INSERT INTO ${qi('RMS')}.${qi('User_Seva_Dept_Role')}
          (${qi('USDR_ID')}, ${qi('CSMS_ID')}, ${qi('Seva_Dept_ID')}, ${qi('Dept_Role_ID')}, ${qi('Ver_From_DT')}, ${qi('Ver_To_DT')})
         VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)`,
        [usdrId, csmsId, sevaDeptId, deptRoleId, FAR_FUTURE]
      );

      await client.query('COMMIT');
      return res.status(201).json({ ok: true, csmsId, name: personName, profileCreated });
    } catch (err) {
      if (client) await client.query('ROLLBACK');
      if (err.code === '23505' && attempt < MAX_ATTEMPTS) {
        // CSMS_ID collision on the MAX+1 guess — retry with a fresh read.
        continue;
      }
      console.error('[POST /admin/assign-role] error', err);
      return res.status(500).json({ error: 'INTERNAL', message: err.message });
    } finally {
      if (client) client.release();
    }
  }
});

// DELETE /api/admin/depts/:id — expire a department.
// Blocked (409) if it has active children or active roles, rather than
// silently orphaning them — the person deleting has to clear those first,
// which is deliberate friction for a structural change like this.
router.delete('/depts/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const kidsQ = await pool.query(
      `SELECT 1 FROM ${qi('RMS')}.${qi('Seva_Dept')}
       WHERE ${qi('Parent_Seva_Dept_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE LIMIT 1`,
      [id]
    );
    if (kidsQ.rowCount > 0) {
      return res.status(409).json({ error: 'HAS_CHILDREN', message: 'This department has active sub-departments. Delete or move those first.' });
    }
    const rolesQ = await pool.query(
      `SELECT 1 FROM ${qi('RMS')}.${qi('Seva_Dept_Role')}
       WHERE ${qi('Seva_Dept_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE LIMIT 1`,
      [id]
    );
    if (rolesQ.rowCount > 0) {
      return res.status(409).json({ error: 'HAS_ROLES', message: 'This department still has active roles. Delete those first.' });
    }
    await pool.query(
      `UPDATE ${qi('RMS')}.${qi('Seva_Dept')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Seva_Dept_ID')} = $1`,
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /admin/depts/:id] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// DELETE /api/admin/roles/:id — expire a role. Cascades to also expire any
// active hierarchy rank row and any active member assignments for it —
// a deleted role can't sensibly still have members, so this doesn't block
// on that the way department deletion blocks on children.
router.delete('/roles/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    await client.query(
      `UPDATE ${qi('RMS')}.${qi('User_Seva_Dept_Role')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Dept_Role_ID')} = $1 AND (${qi('Ver_To_DT')} IS NULL OR ${qi('Ver_To_DT')} >= CURRENT_DATE)`,
      [id]
    );
    await client.query(
      `UPDATE ${qi('RMS')}.${qi('Seva_Dept_Role_HRCHY')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Dept_Role_ID')} = $1 AND ${qi('Ver_To_DT')} >= CURRENT_DATE`,
      [id]
    );
    await client.query(
      `UPDATE ${qi('RMS')}.${qi('Seva_Dept_Role')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('Dept_Role_ID')} = $1`,
      [id]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[DELETE /admin/roles/:id] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  } finally {
    if (client) client.release();
  }
});

// DELETE /api/admin/assignments/:usdrId — remove one specific person from
// one specific role (expires that User_Seva_Dept_Role row only — the role
// itself and other holders are untouched).
router.delete('/assignments/:usdrId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('RMS')}.${qi('User_Seva_Dept_Role')} SET ${qi('Ver_To_DT')} = CURRENT_DATE - INTERVAL '1 day'
       WHERE ${qi('USDR_ID')} = $1`,
      [req.params.usdrId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /admin/assignments/:usdrId] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/admin/people/search?q=... — CSMS people search (User_Profile),
// for autocomplete on any "pick a person" field (satsang conductors, etc).
// Matches on name or email, case-insensitive, limited to 10 results.
router.get('/people/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT ${qi('CSMS_ID')}, ${qi('Seeker_Name')}, ${qi('Seeker_Email')}
       FROM ${qi('RMS')}.${qi('User_Profile')}
       WHERE ${qi('Seeker_Name')} ILIKE $1 OR ${qi('Seeker_Email')} ILIKE $1
       ORDER BY ${qi('Seeker_Name')}
       LIMIT 10`,
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /admin/people/search] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
