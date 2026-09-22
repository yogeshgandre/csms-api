// routes/auth.js
//
// Access is invitation-only. A CSMS_ID must already exist in RMS.User_Profile
// before someone can log in — there is no self-registration path.
//
// Flow:
//   1. The client signs in with Google (public/index.html), restricted by a
//      `hd: 'ssrf.org'` UX hint — a hint only, not a security control.
//   2. The client sends the resulting Firebase ID token here. verifyGoogleIdToken
//      (firebaseAdmin.js) verifies it against Google's own signature and
//      independently checks the domain server-side. This is the real
//      enforcement point — it cannot be bypassed from the browser.
//   3. Only once the token is verified do we look up
//      RMS.User_Profile.Seeker_Email -> CSMS_ID. If nothing matches, the
//      person has never been invited: show a login error, do not create an
//      account on the fly.
//   4. On success, resolve their department/role scope from
//      RMS.User_Seva_Dept_Role + RMS.Seva_Dept + RMS.Role_Seva_Dept_Access,
//      and stamp RMS.User_Invitation.Login_DT if this is their first login.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { verifyGoogleIdToken } = require('../firebaseAdmin');
const router = express.Router();

const SCHEMA_RMS = 'RMS';

router.post('/session', async (req, res) => {
  const { idToken } = req.body || {};

  let decoded;
  try {
    decoded = await verifyGoogleIdToken(idToken);
  } catch (err) {
    const status = err.code === 'WRONG_DOMAIN' ? 403 : 401;
    return res.status(status).json({ error: err.code || 'AUTH_FAILED', message: err.message });
  }

  const email = decoded.email;

  let client;
  try {
    client = await pool.connect();
    // CSMS_ID must already exist — invitation-only.
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

    // Resolve dept/role scope.
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

    // Stamp first login if not already recorded.
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
