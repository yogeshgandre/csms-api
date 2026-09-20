// routes/notifications.js — plain in-app notification inbox. No email/push,
// just rows in RMS.Notification that satsangs.js writes to and this file
// lets the recipient read/mark-read.

const express = require('express');
const { pool, qi } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// GET /api/notifications — most recent 50 for the signed-in user, unread first.
router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${qi('Notification_ID')}, ${qi('Message')}, ${qi('Link_Kind')}, ${qi('Link_ID')}, ${qi('Is_Read')}, ${qi('Created_DT')}
       FROM ${qi('RMS')}.${qi('Notification')}
       WHERE ${qi('CSMS_ID')} = $1
       ORDER BY ${qi('Is_Read')} ASC, ${qi('Created_DT')} DESC
       LIMIT 50`,
      [req.user.csmsId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /notifications] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('RMS')}.${qi('Notification')} SET ${qi('Is_Read')} = true
       WHERE ${qi('Notification_ID')} = $1 AND ${qi('CSMS_ID')} = $2`,
      [req.params.id, req.user.csmsId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /notifications/:id/read] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

router.post('/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ${qi('RMS')}.${qi('Notification')} SET ${qi('Is_Read')} = true WHERE ${qi('CSMS_ID')} = $1 AND ${qi('Is_Read')} = false`,
      [req.user.csmsId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /notifications/read-all] error', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
