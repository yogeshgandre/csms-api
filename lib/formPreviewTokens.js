// In-memory, short-lived tokens that let a Draft/In Review/Paused/Archived
// form's real public page (intake-form.html) be opened by staff without
// it actually being Published \u2014 so "Preview" opens the exact live page
// instead of a separate mockup. No table needed: these are meant to live
// for minutes, not survive a restart, and are never treated as durable
// data. Shared between routes/forms.js (issues them) and
// routes/public-forms.js (validates them).
const tokens = new Map();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function issue(formId) {
  const token = require('crypto').randomBytes(16).toString('hex');
  tokens.set(token, { formId: String(formId), expiresAt: Date.now() + TTL_MS });
  return token;
}

function validate(token, formId) {
  if (!token) return false;
  const entry = tokens.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) { tokens.delete(token); return false; }
  return entry.formId === String(formId);
}

module.exports = { issue, validate };
