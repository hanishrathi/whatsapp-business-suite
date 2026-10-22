# Deploy WhatsApp Suite on your HostingRaja cPanel

This app now runs **100% on your own cPanel** — no Render, no MongoDB Atlas, no
Google Fonts. The database is a single SQLite file on your hosting disk.

**What you need:** a cPanel plan with the **"Setup Node.js App"** icon (you confirmed
you have this) and a domain or subdomain to point at it.

---

## Step 1 — Get the code onto your cPanel

**Option A (easiest): upload a ZIP**
1. On your computer, ZIP the project folder **without** `node_modules` (cPanel installs
   that for you). The ZIP should contain `server/`, `public/` (which holds the
   HTML, `css/`, `js/` and `fonts/`), `package.json`, etc.
2. cPanel → **File Manager** → go to a folder like `whatsapp-suite` (create it under your
   home directory, NOT inside `public_html`).
3. **Upload** the ZIP there and **Extract** it.

**Option B: Git** — cPanel → **Git Version Control** → Clone
`https://github.com/hanishrathi/whatsapp-business-suite.git` into `whatsapp-suite`.

---

## Step 2 — Create the Node.js app

1. cPanel → **Setup Node.js App** → **Create Application**.
2. Fill in:
   - **Node.js version:** pick the highest available (18, 20, or 22).
   - **Application mode:** `Production`
   - **Application root:** `whatsapp-suite` (the folder from Step 1)
   - **Application URL:** choose your domain/subdomain (e.g. `wa.acquihiretech.com`)
   - **Application startup file:** `server/server.js`
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
| `WA_RATE_CURRENCY` + `WA_RATE_MARKETING` / `_UTILITY` / `_AUTHENTICATION` | *(optional)* your billing currency and per-message rates, so the spend estimate matches your invoice. See "Billing" below. |

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

### Where the Meta values come from

Meta's developer dashboard is organised by **use cases** now, not products. An app
created with the *Connect with customers through WhatsApp* use case does not list
WhatsApp in "Available products"; it lives under **Use cases → Customize → Connect
on WhatsApp** in the left menu. (Checked against Meta's docs on 22 Oct 2026; menu
names change, so if one has moved, search the dashboard for the setting's name.)

| You need | Where to find it |
|---|---|
| **`WA_APP_SECRET`** | App Dashboard → **App settings → Basic** → *App secret* → **Show** (it asks for your Facebook password). It must be the secret of the app your WhatsApp account is connected to. You do **not** need the App ID for this app; it is not read anywhere. |
| **Phone Number ID** and **Messaging account ID** (what older docs call the WABA ID) | **Use cases → Customize → Connect on WhatsApp → API Setup**. You enter these under *Accounts* inside the suite, not as environment variables. |
| **Access token** | A permanent one, from a *system user* (below). The "Generate access token" button on API Setup makes a temporary test token that expires within about a day. |

**Making a permanent token** (the suite's *Accounts* page, and `WA_ACCESS_TOKEN` if you
send sign-up codes over WhatsApp):

1. **Business settings → System users → Add**, role *Admin*.
2. **Assign assets** → your app → **Manage app**.
3. **Assign assets** again → your **WhatsApp account** and your **Messaging account**.
   Meta Business Suite does not copy access from one to the other; do both.
4. **Generate token** → pick the app and the longest expiry offered → tick
   `business_management`, `whatsapp_business_management` and `whatsapp_business_messaging`.

**Add a payment method.** Since 1 Oct 2026 Meta charges for service replies as well as
templates, and its pricing notice says a business **with no payment method on file by
30 Sep 2026 stops getting its service messages delivered.** If yours is not set up, do it
now. Per Meta's help pages (these move around, so follow the dashboard if it differs):

- **Business settings → Payment methods → Add**, then either add a credit card or
  *Apply for monthly invoicing* (a credit line; Meta may ask for your business registration).
- **Business settings → Accounts → WhatsApp accounts** → pick the account → **Settings →
  Edit**, and attach the payment method to it.
- Invoices then arrive by email monthly, due within 30 days, and show under
  **Billing and payments**.

See "Billing" below.

---

## Step 4 — Install dependencies & start

1. On the Node.js App page, click **"Run NPM Install"** and wait. This installs
   everything, including the SQLite engine (it downloads a ready-made copy — no
   compiling needed on standard cPanel Linux).
2. Click **Restart** (or "Start App").
3. Visit your URL — e.g. `https://wa.acquihiretech.com`. You should see the login page.

> If "Run NPM Install" ever errors on `better-sqlite3`, open cPanel **Terminal**, then:
> ```
> cd ~/whatsapp-suite
> source /home/USERNAME/nodevenv/whatsapp-suite/NODEVERSION/bin/activate
> npm install --build-from-source better-sqlite3
> ```
> (cPanel shows the exact "source ..." line on the Node.js App page.)

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

## Step 7 — Connect the webhook

Do this before you send any marketing message. Everything Meta tells you arrives here:
**delivery receipts**, **inbound messages**, and the **STOP replies** your recipients send.
Without the webhook the suite never sees a STOP, so it cannot honour opt-outs, which
Meta's policy requires and which can get a number restricted. The spend estimate also
needs it: Meta bills delivered messages only, and "delivered" only arrives here.

1. Add env var `WA_WEBHOOK_VERIFY_TOKEN` = any random string (e.g. from
   `openssl rand -hex 16`) and Restart.
2. In **developers.facebook.com** → your app → **Use cases → Customize → Configuration**
   (older apps: **WhatsApp → Configuration**), set:
   - **Callback URL:** `https://YOUR-DOMAIN/api/webhooks/whatsapp`
   - **Verify token:** the same random string
   Click **Verify and save**, then subscribe to the **messages** field.
3. Make sure the app is in **Live** mode. In Development mode Meta does not send
   some webhooks.
4. Use the dashboard's test-payload button to send one, and check that the suite
   answers 200.

Meta retries a failed delivery for up to 7 days, so a short outage can later
deliver duplicates; the suite ignores a repeat of an event it has already seen.
Calls are signed with your app secret, which is why `WA_APP_SECRET` is mandatory:
if every webhook is rejected, the secret belongs to a different app than the
one sending them.

## Step 8 — Keep scheduled broadcasts on time

cPanel puts Node apps to sleep when idle; a sleeping app can't fire a scheduled
broadcast until someone visits. Fix with a keep-alive ping:

1. cPanel → **Cron Jobs** → add: every 5 minutes,
   `curl -s https://YOUR-DOMAIN/api/health > /dev/null`

## Billing: what Meta charges and what the dashboard estimates

From Meta's pricing page (checked 22 Oct 2026; Meta may change rates on the first day
of any quarter, so check the live page):

- Meta charges for **delivered** messages only, never for ones merely sent, and never
  for messages people send to you.
- Every message has one category: **marketing**, **utility** or **authentication**
  (templates), or **service** (a free-form reply inside the 24-hour window).
- Since **1 Oct 2026** service replies are charged too, and so are utility templates
  sent inside an open window. **Each business phone number** gets one free tier of
  **1,000 delivered service messages a month**; it does not roll over.
- The recipient's **country calling code** decides which market's rate applies.
- Messages inside a *free entry point window* (for example from a click-to-WhatsApp
  ad) are not charged.
- Rate cards are published as CSV/PDF **per billing currency** (INR is available). Your
  account's currency is fixed when it is created.

The dashboard's **Estimated spend** follows those rules but is only an estimate:
it uses **one rate per category for every recipient**, where Meta prices by country,
and it cannot see free entry point windows, so it can read high or low. To make it
match your invoice:

1. Open your rate card on Meta's [pricing page](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
   in **your billing currency** (INR for most Indian accounts).
2. Set `WA_RATE_CURRENCY` (e.g. `INR`) and `WA_RATE_MARKETING`, `WA_RATE_UTILITY`,
   `WA_RATE_AUTHENTICATION` to your main market's per-message rates. Service uses the
   utility rate unless you set `WA_RATE_SERVICE`.
3. Restart. Until all three rates are set the dashboard says it is using placeholder
   rates; those defaults are US dollars and are not Meta's rates for any market.

`WA_SERVICE_FREE_ALLOWANCE` (default `1000`) only needs changing if Meta changes the
free tier.

## Meta's rules for the messages you send

These are Meta's, not this app's, and they change; read the current text before you
launch a campaign: the [Business Policy](https://business.whatsapp.com/policy) and
[opt-in guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in).

- Only message people who have **opted in**, and make the opt-in say who you are.
  Honour opt-outs (the suite does this for STOP once the webhook in Step 7 is live).
- Some categories are restricted (for example medical and healthcare products,
  currency, dating), and regulated-vertical messages may not go to anyone under 18.
- Repeated violations lead to messaging blocks, then permanent disablement.
- Meta restricts *AI Providers* offering general-purpose assistants on the platform
  outside a few markets (from 15 Jan 2026). If you build an AI agent on top of this,
  confirm in the [WhatsApp Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms)
  whether your use falls under it.

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
- **Updates:** upload the changed files (or `git pull`), then click **Restart** on the
  Node.js App page. Your data is preserved.

### Upgrading an install from before the security fixes

Two things moved. Do both, then restart:

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
