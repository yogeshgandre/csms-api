// routes/auth.js
//
// Access is invitation-only. A CSMS_ID must already exist in RMS.User_Profile
// before someone can log in — there is no self-registration path.
//
// Flow (per instructions):
//   1. Firebase Authentication verifies the Google sign-in, restricted to the
//      ssrf.org domain server-side (hd === 'ssrf.org'), per the existing
//      decisions log. That happens on the client via the Firebase SDK.
//   2. The verified email is sent here. We look up RMS.User_Profile.Seeker_Email
//      -> CSMS_ID. If nothing matches, the person has never been invited:
//      show a login error, do not create an account on the fly.
//   3. On success, we also resolve their department/role scope from
//      RMS.User_Seva_Dept_Role + RMS.Seva_Dept + RMS.Role_Seva_Dept_Access,
//      and stamp RMS.User_Invitation.Login_DT if this is their first login.
//
// NOTE — production hardening not yet done: this route currently trusts the
// email it is given. Before this goes anywhere near real seeker data, it
// must verify a Firebase ID token server-side (firebase-admin.auth()
// .verifyIdToken) rather than accept a bare email in the request body. This
// is called out explicitly so it isn't silently skipped.

const express = require('express');
const { pool, qi } = require('../db/pool');
const router = express.Router();

const SCHEMA_RMS = 'RMS';

router.post('/session', async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }

  let client;
  try {
    client = await pool.connect();
    // 1. CSMS_ID must already exist — invitation-only.
    const userQ = await client.query(
      `SELECT ${qi('CSMS_ID')}, ${qi('Seeker_ID')}, ${qi('Seeker_Name')}, ${qi('Seeker_Email')}
       FROM ${qi(SCHEMA_RMS)}.${qi('User_Profile')}
       WHERE lower(${qi('Seeker_Email')}) = lower($1)
       LIMIT 1`,
      [email]
    );

    if (userQ.rowCount === 0) {
      // Deliberately generic — do not reveal whether the email exists
      // elsewhere in the system, only that it has no CSMS access.
      return res.status(401).json({
        error: 'NO_CSMS_ACCESS',
        message: 'No CSMS access found for this email. Access is by invitation only — contact your administrator.',
      });
    }

    const user = userQ.rows[0];

    // 2. Resolve dept/role scope.
    const scopeQ = await client.query(
      `SELECT usdr.${qi('Seva_Dept_ID')}, usdr.${qi('Dept_Role_ID')},
              sd.${qi('Seva_Dept_Name')}, sd.${qi('Parent_Seva_Dept_ID')},
              sdr.${qi('Dept_Role_Name')}
       FROM ${qi(SCHEMA_RMS)}.${qi('User_Seva_Dept_Role')} usdr
       JOIN ${qi(SCHEMA_RMS)}.${qi('Seva_Dept')} sd ON sd.${qi('Seva_Dept_ID')} = usdr.${qi('Seva_Dept_ID')}
       JOIN ${qi(SCHEMA_RMS)}.${qi('Seva_Dept_Role')} sdr ON sdr.${qi('Dept_Role_ID')} = usdr.${qi('Dept_Role_ID')}
       WHERE usdr.${qi('CSMS_ID')} = $1
         AND (usdr.${qi('Ver_To_DT')} IS NULL OR usdr.${qi('Ver_To_DT')} >= CURRENT_DATE)
       ORDER BY sd.${qi('Seva_Dept_Name')}`,
      [user.CSMS_ID]
    );

    // 3. Stamp first login if not already recorded.
    await client.query(
      `UPDATE ${qi(SCHEMA_RMS)}.${qi('User_Invitation')}
       SET ${qi('Login_DT')} = CURRENT_DATE
       WHERE ${qi('CSMS_ID')} = $1 AND ${qi('Login_DT')} IS NULL`,
      [user.CSMS_ID]
    );

    return res.json({
      csmsId: user.CSMS_ID,
      seekerId: user.Seeker_ID,
      name: user.Seeker_Name,
      email: user.Seeker_Email,
      deptRoles: scopeQ.rows,
    });
  } catch (err) {
    console.error('[auth/session] error', err);
    return res.status(500).json({ error: 'INTERNAL', message: 'Could not resolve session.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
