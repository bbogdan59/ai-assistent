# WhatsApp Calendar Bot

A WhatsApp group bot that:

- Answers questions about a shared Google Calendar ("is anything on tonight?").
- Adds events to the calendar when asked ("add dinner with the Popescus Friday at 7").
- Logs everything said in the group and, once a month (or on request), posts a
  recap of decisions, action items, and open questions from the last 30 days.

It's a small always-on Python/Flask service (WhatsApp webhook receiver),
backed by Postgres (message history), the WhatsApp Cloud API, Google
Calendar, and Claude (Anthropic API) for understanding requests and writing
the recap.

## Important limitation - read this first

This bot uses the **official WhatsApp Business Platform (Cloud API)**, which
recently added a Groups API (create/manage groups, `recipient_type: "group"`
messaging, and group webhook events). As of this writing that feature is
newer and access may be limited/rolled out gradually, and Meta's public docs
on the exact incoming-webhook JSON shape for a group text message are thin.

Practically, this means:

- Your bot's WhatsApp Business number generally needs to **create the group
  itself via the Groups API** (or be added as a participant by another
  number that has group-management access) - you likely can't just add an
  arbitrary business number to an existing personal WhatsApp group the way
  you'd add a friend.
- You should request/confirm Groups API access for your WhatsApp Business
  Account in Meta's developer console before relying on this.
- The webhook parser in `app/whatsapp.py` (`parse_incoming_messages`) is
  written defensively and checks the most likely field names for a group
  identifier, but you should set `DEBUG_LOG_RAW_WEBHOOKS=true` and look at
  a real incoming group message payload once you have access, to confirm
  (and if needed, tweak) how the group id is extracted.
- If Groups API access isn't available to you, the practical alternative is
  an unofficial library like Baileys (logs in as a normal WhatsApp account
  via QR code, can join any group like a regular member) - a materially
  different, ToS-grey-area architecture. Ask if you want that version
  instead; this repo implements the official-API approach.

## How it works

1. Every text message posted in the group is stored in Postgres.
2. If a message contains the bot's name (`BOT_NAME`, e.g. "Ana"), it's
   treated as addressed to the bot:
   - If it also contains "recap"/"summary"/"summarize", the bot immediately
     posts a recap of the last `DIGEST_LOOKBACK_DAYS` days.
   - Otherwise, the message is sent to Claude, which can call
     `list_calendar_events` / `create_calendar_event` tools against Google
     Calendar, then replies in the group.
3. A cron job (`DIGEST_CRON`, default: 8am UTC on the 1st of each month)
   automatically posts the same kind of recap for every group the bot has
   seen messages in.

## Setup

### 1. WhatsApp Business Platform (Meta for Developers)

1. Create an app at [developers.facebook.com](https://developers.facebook.com/)
   and add the "WhatsApp" product.
2. Under WhatsApp > API Setup, note your **Phone Number ID**, and generate a
   **permanent access token** (System User token with `whatsapp_business_messaging`
   permission - the temporary token from the quickstart expires in 24h).
3. Under App Settings > Basic, note your **App Secret** (`WHATSAPP_APP_SECRET`).
4. Request/enable Groups API access for your WhatsApp Business Account, and
   use it (or the Graph API Explorer) to create the group your bot will run
   in - see Meta's "Group messaging" docs under WhatsApp Business Platform.
5. You'll set the webhook URL and verify token in step 4 (deploy) below.

### 2. Google Calendar (OAuth2, your personal account)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project, enable the **Google Calendar API**.
2. Configure the OAuth consent screen (External is fine; you can leave it in
   "Testing" mode since only your own account will authorize it - just add
   your Google account under "Test users").
3. Create an **OAuth client ID** of type **Desktop app**. Note the client ID
   and secret.
4. For each calendar you want the bot to use (e.g. the church calendar),
   open Google Calendar > Settings > [that calendar] > "Integrate calendar"
   and copy its **Calendar ID**. If it's not your own calendar, make sure
   it's shared with your Google account with "Make changes to events"
   permission.
5. Copy `.env.example` to `.env`, fill in `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`, then run:
   ```
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   python scripts/get_google_token.py
   ```
   Open the printed URL, approve access, and copy the `GOOGLE_REFRESH_TOKEN`
   it prints into your `.env` (and later into Railway's env vars).
6. Fill in `CALENDARS` with `name:calendarId` pairs, e.g.
   `church:abc123@group.calendar.google.com`, and set `DEFAULT_CALENDAR`.

### 3. Anthropic Claude

Get an API key from [console.anthropic.com](https://console.anthropic.com/)
and set `ANTHROPIC_API_KEY`.

### 4. Deploy to Railway

1. Create a new Railway project from this repo (it will detect the
   `Dockerfile`).
2. Add Railway's **Postgres** plugin to the project - it sets `DATABASE_URL`
   automatically.
3. Add all remaining env vars from `.env.example` under the service's
   Variables tab (`WHATSAPP_*`, `BOT_NAME`, `TIMEZONE`, `ANTHROPIC_*`,
   `GOOGLE_*`, `CALENDARS`, `DEFAULT_CALENDAR`).
4. Deploy, then copy the service's public URL.
5. Back in Meta for Developers > WhatsApp > Configuration, set the
   **Callback URL** to `https://<your-railway-url>/webhook` and the
   **Verify Token** to the same value as `WHATSAPP_VERIFY_TOKEN`. Subscribe
   to the `messages` webhook field (and any group-specific fields Meta
   exposes, e.g. `group_lifecycle_update`, if you want those too).

### 5. Local development

```
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in real values
python -m app.server    # runs against the DATABASE_URL in .env (e.g. a local/Railway Postgres)
```

Use a tool like `ngrok` to expose your local port for Meta's webhook while
testing.

Note: the app uses APScheduler to run the monthly recap job in-process, and
the Dockerfile runs gunicorn with a single worker (`--workers 1`) for
exactly that reason - running more than one worker/process would schedule
and fire the recap job multiple times. If you ever need to scale this
service up, move the recap job to a separate scheduled process instead of
increasing worker count.

## Configuration reference

See `.env.example` for the full list of environment variables and comments
on each. Key ones:

- `BOT_NAME` - the word people say to address the bot in the group.
- `CALENDARS` / `DEFAULT_CALENDAR` - named calendars the bot can read/write.
- `DIGEST_CRON` / `DIGEST_LOOKBACK_DAYS` - when and how far back the
  automatic recap looks.
- `DEBUG_LOG_RAW_WEBHOOKS` - logs full incoming webhook JSON; turn on while
  confirming the real group-message payload shape, then turn off.

## Possible follow-ups (not implemented)

- Treating a WhatsApp *reply* to one of the bot's own messages as "addressed
  to the bot" even without saying its name.
- Supporting multiple groups with different calendar access per group.
- A `/health`-based uptime check (the endpoint exists at `GET /health`; wire
  it into Railway's health check settings if you want auto-restarts on
  failure).
