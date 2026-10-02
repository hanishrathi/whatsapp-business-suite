const path = require('path');

/*
 * Every filesystem location the app uses, resolved from one place.
 *
 * The deployable build (dist/server.js) is a single bundled file, and in a
 * bundle every module shares that file's __dirname. Paths written relative to
 * each source file's own folder would then point somewhere else, so they are
 * all derived from the project root here instead. The build defines
 * __WBS_BUNDLED__; running from source it is undefined.
 */
/* global __WBS_BUNDLED__ */
const ROOT = typeof __WBS_BUNDLED__ !== 'undefined'
  ? path.resolve(__dirname, '..')          // dist/server.js
  : path.resolve(__dirname, '..', '..');   // server/config/paths.js

module.exports = {
  ROOT,
  ENV_FILE: path.join(ROOT, '.env'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  UPLOADS_DIR: path.join(ROOT, 'server', 'uploads'),
  AVATARS_DIR: path.join(ROOT, 'server', 'uploads', 'avatars'),
  // Outside the application folder, so the web server can never publish it.
  DEFAULT_DATABASE_PATH: path.join(ROOT, '..', 'whatsapp-suite-data', 'app.db'),
};
