// routes/satsangs.js — Calendar tab. Reads real Satsang_Event_Defn/Status,
// not the mock CAL array the prototype currently uses.
//
// NOTE: Satsang_Event_Defn.Event_ST_DT_TIME is `bigint`, not a timestamp
// type — presumably a unix epoch. Confirm the unit (seconds vs ms) before
// trusting the date math below; written assuming seconds.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// GET /api/satsangs/upcoming
router.get('/upcoming', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT se.${qi('SE_ID')}, se.${qi('Satsang_ID')}, se.${qi('Event_ST_DT_TIME')},
              se.${qi('Event_Time_City')}, se.${qi('Event_Duration')},
              ms.${qi('Satsang_Name')}, ms.${qi('Satsang_Short_Name')}, mt.${qi('ST_Name')},
              est.${qi('Current_Status')}, est.${qi('Event_Link')}
       FROM SCS.${qi('Satsang_Event_Defn')} se
       JOIN SCS.${qi('M_Satsang')} ms ON ms.${qi('Satsang_ID')} = se.${qi('Satsang_ID')}
       LEFT JOIN SCS.${qi('M_Satsang_type')} mt ON mt.${qi('Satsang_Type_ID')} = ms.${qi('Satsang_Type_ID')}
       LEFT JOIN SCS.${qi('Satsang_Event_Status')} est ON est.${qi('SE_ID')} = se.${qi('SE_ID')}
       WHERE to_timestamp(se.${qi('Event_ST_DT_TIME')}) >= NOW()
       ORDER BY se.${qi('Event_ST_DT_TIME')} ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /satsangs/upcoming] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/satsangs/:satsangId/attendees
router.get('/:satsangId/attendees', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sas.${qi('AS_CSMS_ID')}, sas.${qi('Remarks')}, up.${qi('Seeker_Name')}
       FROM SCS.${qi('Satsang_Attending_Seekers')} sas
       LEFT JOIN RMS.${qi('User_Profile')} up ON up.${qi('CSMS_ID')} = sas.${qi('AS_CSMS_ID')}
       WHERE sas.${qi('Satsang_ID')} = $1 AND sas.${qi('Ver_To_DT')} IS NULL`,
      [req.params.satsangId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /satsangs/:id/attendees] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// GET /api/satsangs/transfers — Attendee_Transfer_Requests. New: no
// equivalent existed anywhere in the prototype.
router.get('/transfers', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tr.*, ts.${qi('TR_Status_Name')}
       FROM SCS.${qi('Attendee_Transfer_Requests')} tr
       LEFT JOIN SCS.${qi('Transfer_Status')} ts ON ts.${qi('TR_Status_ID')} = tr.${qi('TR_Status_ID')}
       ORDER BY tr.${qi('TR_Initiated_DT')} DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /satsangs/transfers] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
