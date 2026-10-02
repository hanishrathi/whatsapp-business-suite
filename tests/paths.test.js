const path = require('path');
const paths = require('../server/config/paths');

const REPO_ROOT = path.resolve(__dirname, '..');

describe('config/paths', () => {
  test('resolves from the project root when running from source', () => {
    expect(paths.ROOT).toBe(REPO_ROOT);
    expect(paths.PUBLIC_DIR).toBe(path.join(REPO_ROOT, 'public'));
    expect(paths.ENV_FILE).toBe(path.join(REPO_ROOT, '.env'));
    expect(paths.AVATARS_DIR).toBe(path.join(REPO_ROOT, 'server', 'uploads', 'avatars'));
  });

  test('default database sits outside the project folder', () => {
    const rel = path.relative(REPO_ROOT, paths.DEFAULT_DATABASE_PATH);
    expect(rel.startsWith('..')).toBe(true);
    expect(paths.DEFAULT_DATABASE_PATH).toBe(path.join(path.dirname(REPO_ROOT), 'whatsapp-suite-data', 'app.db'));
  });
});
