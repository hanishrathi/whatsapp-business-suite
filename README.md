# WhatsApp Business Suite

Self-hosted multi-account WhatsApp Business dashboard by AcquiHire Tech.
Node.js + Express + SQLite, in a single process, with no external services
beyond Meta's Cloud API and your own SMTP.

Deploying to cPanel? See **[CPANEL-DEPLOY.md](CPANEL-DEPLOY.md)**. This page is
for running it on your own machine.

## Requirements

- Node.js 18 or newer (`node -v`)
- No database server — SQLite is a file

## Run it locally

### 1. Get the code and install

```bash
git clone https://github.com/hanishrathi/whatsapp-business-suite.git
cd whatsapp-business-suite
npm install
```

### 2. Create a data directory *outside* the project

```bash
mkdir -p ../whatsapp-suite-data
```

The database holds password hashes, contact details and your WhatsApp access
tokens. Keeping it out of the application folder means a web-server
misconfiguration can never publish it.

### 3. Generate secrets

```bash
node -e "console.log('JWT_SECRET='     + require('crypto').randomBytes(64).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

`ENCRYPTION_KEY` must be exactly 64 hex characters — it is the AES-256 key that
protects stored access tokens. Lose it and every saved token becomes
unreadable.

### 4. Write `.env`

Copy `.env.example` to `.env` and fill it in, or start from this minimum:

```bash
NODE_ENV=production
PORT=4000
BASE_URL=http://localhost:4000

# Absolute path, outside this folder. `~` is not expanded.
DATABASE_PATH=/absolute/path/to/whatsapp-suite-data/app.db

JWT_SECRET=<from step 3>
ENCRYPTION_KEY=<from step 3>

# Your Meta App Secret (App Dashboard -> Settings -> Basic). Required whenever
# NODE_ENV is not "development" or "test". Any random value works for local
# testing if you are not receiving real webhooks.
WA_APP_SECRET=<your app secret>
```

`.env` is gitignored, along with every other `.env*` file except the template.

> **`NODE_ENV=production` locally is deliberate** — it exercises the same code
> paths as your server. The HTTPS redirect only fires behind a proxy that sets
> `x-forwarded-proto`, so it will not interfere. Use `development` only if you
> want raw error messages in API responses.

### 5. Start

```bash
npm start          # or: npm run dev   (nodemon, reloads on change)
```

> **Shell environment variables beat `.env`.** dotenv never overwrites a
> variable that already exists, so an exported `NODE_ENV` or `PORT` silently
> wins. Check the startup banner says the port and mode you expect. The same
> applies on cPanel, where the Node.js App panel's variables take precedence.

### 6. Verify

```bash
curl -s localhost:4000/api/health
```

Expect `{"success":true,"status":"operational",...}`. This query hits the
database, so a 200 also proves `DATABASE_PATH` is correct.

These must all return **404** — only `public/` is ever served:

```bash
for p in /server/server.js /server/data/app.db-wal /.env /.git/config /package.json; do
  echo "$(curl -s -o /dev/null -w '%{http_code}' localhost:4000$p)  $p"
done
```

### 7. Create an account

Open `http://localhost:4000/register`. Sign-up needs an email OTP, and with no
SMTP configured locally the message never arrives, so mark the account verified
directly:

```bash
node -e "
require('dotenv').config();
const d = require('./server/config/database'); d.init(process.env.DATABASE_PATH);
const u = require('./server/data/users');
const x = u.findByEmail('you@example.com');
u.update(x._id, { isEmailVerified: true, isPhoneVerified: true });
console.log('verified:', x.email);
"
```

Then sign in at `http://localhost:4000/login`.

## Tests

```bash
npm test          # 124 tests across 9 suites
npm run audit     # npm audit, high severity and above
```

The suite uses an in-memory database and mocks Meta's API. It strips
behaviour-changing variables that your `.env` would otherwise inject, so it
gives the same result on your machine as in CI.

## Sending real messages

Broadcasts need a WhatsApp Business Account and a Cloud API phone number. Add
one under **Accounts** with its Phone Number ID, WABA ID and a permanent access
token. Two things are enforced and cannot be worked around, because WhatsApp
requires them:

- **Business-initiated messages must use a template Meta has approved.** Draft
  templates are composed here, submitted in Meta Business Manager, then pulled
  back with *Sync templates*. Free-form text is only allowed as a reply inside
  the 24-hour customer service window.
- **Recipients must have recorded opt-in,** and opt-out must be honoured. A
  contact with no consent is excluded from every broadcast, and an inbound
  `STOP` unsubscribes them automatically.

A number registered to the Cloud API leaves the WhatsApp Business app. To keep
using a number in that app, add it as a **manual** channel: broadcasts to it
produce click-to-chat links you send yourself, rather than API calls.

## Layout

```
public/      Everything served over HTTP — HTML, css/, js/, fonts/
server/
  routes/    HTTP endpoints
  services/  Send engine and scheduler
  data/      SQLite access, one module per table
  utils/     Graph API client, crypto, billing, OTP
  config/    Database schema and migrations, environment detection
tests/       Jest + supertest
```

Nothing outside `public/` is reachable over HTTP.
