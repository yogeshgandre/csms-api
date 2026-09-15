// firebaseAdmin.js
//
// Verifies the Google ID token the front end sends after sign-in. This is
// where the ssrf.org domain restriction is actually enforced — the client's
// `hd: 'ssrf.org'` hint (public/index.html) only narrows Google's account
// picker UI. Anyone can bypass a client-side hint. This file cannot be
// bypassed, because it runs on the server against Google's own signature
// verification.
//
// Render is not a GCP environment, so there's no ambient service-account
// credential the way there would be on Cloud Run/Cloud Functions. A real
// service account key must be supplied explicitly via the
// FIREBASE_SERVICE_ACCOUNT env var (see .env.example).
//
// Uses firebase-admin's modular API (v9+/v14 style: firebase-admin/app,
// firebase-admin/auth) — the older admin.initializeApp()/admin.auth() shape
// on the top-level import no longer exists in current versions.

require('dotenv').config();
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

if (!getApps().length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn(
      '[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT is not set. Google sign-in ' +
      'verification will fail until it is added — see .env.example.'
    );
  } else {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
}

const ALLOWED_DOMAIN = 'ssrf.org';

/**
 * Verifies a Google ID token and enforces the ssrf.org restriction.
 * Throws with a `.code` on failure so callers can pick the right HTTP status.
 */
async function verifyGoogleIdToken(idToken) {
  if (!idToken) {
    const err = new Error('No ID token provided.');
    err.code = 'NO_TOKEN';
    throw err;
  }

  if (!getApps().length) {
    const err = new Error('Server is not configured for Google sign-in verification.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(idToken);
  } catch (e) {
    const err = new Error('Could not verify Google sign-in.');
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  // hd is Google Workspace's "hosted domain" claim — present when the user
  // signed in with a Workspace account belonging to that domain. It is
  // absent for personal @gmail.com accounts. Check both hd and the email
  // suffix: hd is the authoritative signal, the email-suffix check is a
  // defense-in-depth backstop in case hd is ever missing on a legitimate
  // Workspace token for some edge case.
  const email = decoded.email || '';
  const emailDomainOk = email.toLowerCase().endsWith('@' + ALLOWED_DOMAIN);
  const hdOk = decoded.hd === ALLOWED_DOMAIN;

  if (!hdOk && !emailDomainOk) {
    const err = new Error('Only ssrf.org Google accounts may sign in.');
    err.code = 'WRONG_DOMAIN';
    throw err;
  }

  return decoded; // includes .email, .uid, .hd, etc.
}

module.exports = { verifyGoogleIdToken };
