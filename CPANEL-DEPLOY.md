# Deploy WhatsApp Suite on your HostingRaja cPanel

This app now runs **100% on your own cPanel** — no Render, no MongoDB Atlas, no
Google Fonts. The database is a single SQLite file on your hosting disk.

**What you need:** a cPanel plan with the **"Setup Node.js App"** icon (you confirmed
you have this) and a domain or subdomain to point at it.

**It fits small file limits.** Hosting plans cap how many files you may store
(cPanel's *File Usage*). A normal Node install writes about 9,000 files. This app
ships ready-built as one file, `dist/server.js`, so cPanel only installs the two
packages that contain compiled code — about **600 files** in total, plus the app.

---

## Step 1 — Get the code onto your cPanel

**Option A (recommended): Git** — cPanel → **Git Version Control** → Clone
`https://github.com/hanishrathi/whatsapp-business-suite.git` into `whatsapp-suite`.
Updates are then one click (**Pull**).

**Option B: upload a ZIP** — the server only needs two folders:
1. On your computer, ZIP the **`dist`** and **`public`** folders together (no
   `node_modules` anywhere). Nothing else from the project is used at runtime.
2. cPanel → **File Manager** → create `whatsapp-suite` in your home directory,
   **not** inside `public_html`.
3. **Upload** the ZIP there and **Extract** it, so you have
   `whatsapp-suite/dist` and `whatsapp-suite/public`.

---

## Step 2 — Create the Node.js app

1. cPanel → **Setup Node.js App** → **Create Application**.
2. Fill in:
   - **Node.js version:** `20` or newer — pick the highest offered. (18 is too old
     for the SQLite and image libraries.)
   - **Application mode:** `Production`
   - **Application root:** `whatsapp-suite/dist` — note the **`/dist`**
   - **Application URL:** choose your domain/subdomain (e.g. `wa.acquihiretech.com`)
   - **Application startup file:** `server.js`
3. Click **Create**.

---

## Step 3 — Add your settings (environment variables)

Still on the Node.js App page, find **"Environment variables"** and add these
(click "Add Variable" for each). Copy the secret values exactly:

| Name | Value |
|------|-------|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | *(use the long value I gave you in chat)* |
| `ENCRYPTION_KEY` | *(use the 64-character value I gave you in chat)* |
| `DATABASE_PATH` | `/home/YOUR-CPANEL-USER/whatsapp-suite-data/app.db` **(must be outside the app folder — see the warning below)** |
| `WA_APP_SECRET` | *(your Meta App Secret — the app will not start without it)* |
| `BASE_URL` | `https://wa.acquihiretech.com` *(your URL)* |
| `MAX_WHATSAPP_ACCOUNTS` | `25` |
| `OTP_EXPIRY_MINUTES` | `10` |
| `FROM_EMAIL` | `noreply@acquihiretech.com` |
| `FROM_NAME` | `WhatsApp Suite by AcquiHire Tech` |

**Email OTP (so users get verification codes):** create an email account in cPanel
(e.g. `noreply@acquihiretech.com`), then also add:

| Name | Value |
|------|-------|
| `SMTP_HOST` | `mail.acquihiretech.com` *(your cPanel mail server)* |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `noreply@acquihiretech.com` |
| `SMTP_PASS` | *(that mailbox's password)* |

Click **Save**.

> **Why `DATABASE_PATH` must sit outside the app folder.** The database holds
> password hashes, your contacts' details and your WhatsApp access tokens. Keep
> it in a sibling folder (`whatsapp-suite-data`), never inside `whatsapp-suite`.
> Create it once in cPanel → File Manager, at the same level as the app folder.

> **Why `WA_APP_SECRET` is required.** Your webhook URL is not a secret. Without
> the app secret there is no way to tell a real call from Meta apart from a
> forged one, so anyone who learns the URL could fake inbound messages, opt-outs
> and delivery reports. The app refuses to boot in production without it.

---

## Step 4 — Install dependencies & start

1. On the Node.js App page, click **"Run NPM Install"** and wait. Because the
   application root is `dist`, this installs only `better-sqlite3` (the database
   engine) and `sharp` (profile-photo resizing). Both download ready-made copies
   for your server — no compiling.
2. npm also keeps a download cache that counts against your file limit. Clear it
   once from cPanel → **Terminal**: `npm cache clean --force`
3. Click **Restart** (or "Start App").
4. Visit your URL — e.g. `https://wa.acquihiretech.com`. You should see the login page.

> If "Run NPM Install" ever errors on `better-sqlite3`, open cPanel **Terminal**, then:
> ```
> source /home/USERNAME/nodevenv/whatsapp-suite/dist/NODEVERSION/bin/activate
> cd ~/whatsapp-suite/dist
> npm install --omit=dev --build-from-source better-sqlite3
> ```
> (cPanel shows the exact "source ..." line at the top of the Node.js App page.)
>
> **Don't** run `npm install` in the `whatsapp-suite` folder itself — that
> installs the developer tooling too, about 9,000 files.

---

## Step 5 — Point your domain (if using a subdomain)

If you chose `wa.acquihiretech.com` and it's not already a subdomain:
1. cPanel → **Domains** (or **Subdomains**) → create `wa` under `acquihiretech.com`,
   and set its document root to your app folder (cPanel's Node.js setup usually wires
   this automatically when you pick the Application URL).
2. cPanel → **SSL/TLS Status** → run **AutoSSL** so `https://` works.

---

## Step 6 — Verify it's live

1. `https://wa.acquihiretech.com/api/health` → should show
   `{"success":true,"status":"operational",...}`
2. `https://wa.acquihiretech.com/register` → create your owner account.
3. Check your email for the verification code, verify, and you're in.

To make yourself an **admin** later: there's no admin UI yet; the role lives in the
database. (Ask me and I'll add an admin tool when you need it.)

---

## Step 7 — Get delivery receipts (after your first broadcast works)

Broadcasts send without this, but "delivered/read" stats need Meta to call you back:

1. Add env var `WA_WEBHOOK_VERIFY_TOKEN` = any random string (e.g. from
   `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`) and Restart.
2. In **developers.facebook.com** → your app → **WhatsApp → Configuration**, set:
   - **Callback URL:** `https://YOUR-DOMAIN/api/webhooks/whatsapp`
   - **Verify token:** the same random string
   Click **Verify and save**, then subscribe to the **messages** webhook field.

## Step 8 — Keep scheduled broadcasts on time

cPanel puts Node apps to sleep when idle; a sleeping app can't fire a scheduled
broadcast until someone visits. Fix with a keep-alive ping:

1. cPanel → **Cron Jobs** → add: every 5 minutes,
   `curl -s https://YOUR-DOMAIN/api/health > /dev/null`

## Backups & updates
- **Backups:** the database runs in WAL mode, so **`app.db` on its own is not a
  complete backup** — recent writes live in the sibling `app.db-wal` file, and
  copying only `app.db` silently loses them. Back it up one of these two ways:

  1. **Safest (a consistent snapshot, safe while the app is running).** In cPanel
     → Terminal:
     ```
     sqlite3 /home/YOUR-CPANEL-USER/whatsapp-suite-data/app.db ".backup '/home/YOUR-CPANEL-USER/backups/app-$(date +%F).db'"
     ```
     Add that as a daily cron job (cPanel → Cron Jobs) and keep a week of files.

  2. **Or copy all three files together** — `app.db`, `app.db-wal` and
     `app.db-shm` — and restore all three together.

  Whichever you choose, **restore once into a test app before you need it.** A
  backup you have never restored is not yet a backup.
- **Updates:** **Pull** in Git Version Control (or re-upload `dist` and `public`),
  then click **Restart** on the Node.js App page. `dist/server.js` arrives
  ready-built, so there is nothing to compile. Click **Run NPM Install** first only
  if `dist/package.json` changed. Your data is preserved.

### Upgrading an install from before the security fixes

Three things changed. Do all three, then restart:

1. **Move your database out of the app folder.** Stop the app, then in cPanel →
   Terminal:
   ```
   mkdir -p ~/whatsapp-suite-data
   mv ~/whatsapp-suite/server/data/app.db*  ~/whatsapp-suite-data/
   ```
   (the `*` matters — it moves the `-wal` and `-shm` files too). Then set
   `DATABASE_PATH` to `/home/YOUR-CPANEL-USER/whatsapp-suite-data/app.db`.

2. **Add `WA_APP_SECRET`** to the environment variables. The app will not start
   in production without it.

3. **Switch to the single-file build.** On the Node.js App page, **Edit** the app
   and set **Application root** to `whatsapp-suite/dist` and **Application
   startup file** to `server.js`, with Node.js `20` or newer. If your cPanel won't
   let you edit the root, write down your environment variables, delete the app
   (this does not touch your files or database) and create it again as in Step 2.
   Then **Run NPM Install** and **Restart**.

   Free the files the old full install used:
   ```
   rm -rf ~/whatsapp-suite/node_modules
   rm -rf ~/nodevenv/whatsapp-suite/[0-9]*
   npm cache clean --force
   ```
   The second line removes only the old install's per-version folders (named
   `18`, `20`, …), not the new one under `~/nodevenv/whatsapp-suite/dist`.

Earlier versions served the whole application folder over the web, which made the
database, the server source and the `.git` folder downloadable by anyone. If your
install was ever publicly reachable, treat the access tokens in it as exposed:
rotate them in Meta Business Manager, and ask users to change their passwords.

## What's NOT a third party anymore
- ✅ Hosting: your cPanel (was Render)
- ✅ Database: SQLite file on your cPanel (was MongoDB Atlas)
- ✅ Fonts: self-hosted in `/fonts` (was Google Fonts)

The only optional external calls left are **email sending** (your own cPanel mailbox)
and **WhatsApp message delivery** (Meta's API — unavoidable, that's WhatsApp itself).
