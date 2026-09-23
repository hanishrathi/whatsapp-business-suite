/*
 * One place that decides which environment the app is running in.
 *
 * NODE_ENV used to be compared against 'production' in four separate places
 * (secret checks, CORS allowlist, HTTPS redirect, error redaction). A typo or a
 * missing variable in the cPanel UI silently turned all four off at once while
 * the app kept working, which is the worst possible failure mode. So the test
 * is inverted here: only the two values we explicitly recognise as non-production
 * relax anything. Anything else — 'Production', 'prod', '', undefined — is
 * treated as production and keeps every protection on.
 */

const RAW = String(process.env.NODE_ENV || '').trim().toLowerCase();

const isTest = RAW === 'test';
const isDevelopment = RAW === 'development';
const isProduction = !isTest && !isDevelopment;

// True when NODE_ENV held something we did not recognise and we defaulted to
// production. Worth saying out loud at boot so a typo is visible, not silent.
const isUnrecognised = isProduction && RAW !== 'production';

module.exports = { RAW, isTest, isDevelopment, isProduction, isUnrecognised };
