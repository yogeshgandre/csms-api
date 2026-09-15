// middleware/auth.js
//
// PROTOTYPE STAND-IN. Every request must carry an `x-csms-id` header. In
// production this becomes a verified session (signed cookie or JWT set by
// POST /api/auth/session), not a bare header the client can set to anything.
// Flagging this loudly rather than letting it look finished: as written,
// anyone can claim any CSMS_ID. Do not point this at real seeker data
// until session verification replaces this header.

const { pool, qi } = require('../db/pool');

async function requireAuth(req, res, next) {
  const csmsId = req.header('x-csms-id');
  if (!csmsId) {
    return res.status(401).json({ error: 'NO_SESSION', message: 'Missing x-csms-id.' });
  }

  try {
    const scopeQ = await pool.query(
      `SELECT usdr.${qi('Seva_Dept_ID')}, sd.${qi('Seva_Dept_Name')}, sd.${qi('Parent_Seva_Dept_ID')},
              sdr.${qi('Dept_Role_Name')}
       FROM RMS.${qi('User_Seva_Dept_Role')} usdr
       JOIN RMS.${qi('Seva_Dept')} sd ON sd.${qi('Seva_Dept_ID')} = usdr.${qi('Seva_Dept_ID')}
       JOIN RMS.${qi('Seva_Dept_Role')} sdr ON sdr.${qi('Dept_Role_ID')} = usdr.${qi('Dept_Role_ID')}
       WHERE usdr.${qi('CSMS_ID')} = $1
         AND (usdr.${qi('Ver_To_DT')} IS NULL OR usdr.${qi('Ver_To_DT')} >= CURRENT_DATE)`,
      [csmsId]
    );

    if (scopeQ.rowCount === 0) {
      return res.status(403).json({ error: 'NO_ROLE_ASSIGNED', message: 'This CSMS_ID has no active department/role assignment.' });
    }

    req.user = {
      csmsId,
      deptRoles: scopeQ.rows,
      deptIds: scopeQ.rows.map(r => r.Seva_Dept_ID),
    };
    next();
  } catch (err) {
    console.error('[auth middleware] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
}

module.exports = { requireAuth };
