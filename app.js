// app.js — CSMS API. Serves the front end and the /api routes together,
// since Firebase Hosting + a single backend keeps this simple for now.
// Split them later if Firebase Hosting ends up serving static assets
// separately from wherever this Express app runs (Cloud Run, most likely,
// to sit next to Cloud SQL).

const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const seekerRoutes = require('./routes/seekers');
const deptRoutes = require('./routes/depts');
const satsangRoutes = require('./routes/satsangs');
const intakeRoutes = require('./routes/intake');
const masterRoutes = require('./routes/master');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/seekers', seekerRoutes);
app.use('/api/depts', deptRoutes);
app.use('/api/satsangs', satsangRoutes);
app.use('/api/intake', intakeRoutes);
app.use('/api/master', masterRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Serve the wired-up front end.
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`CSMS API listening on :${PORT}`));

module.exports = app;
