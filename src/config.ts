import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseCalendars(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) {
      throw new Error(
        `Invalid CALENDARS entry "${trimmed}" - expected format name:calendarId`
      );
    }
    const name = trimmed.slice(0, idx).trim().toLowerCase();
    const id = trimmed.slice(idx + 1).trim();
    map[name] = id;
  }
  return map;
}

const calendars = parseCalendars(required("CALENDARS"));
const defaultCalendar = (process.env.DEFAULT_CALENDAR || Object.keys(calendars)[0] || "").toLowerCase();

if (!calendars[defaultCalendar]) {
  throw new Error(
    `DEFAULT_CALENDAR "${defaultCalendar}" is not one of the configured CALENDARS: ${Object.keys(calendars).join(", ")}`
  );
}

export const config = {
  port: Number(process.env.PORT || 3000),

  whatsapp: {
    token: required("WHATSAPP_TOKEN"),
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    appSecret: process.env.WHATSAPP_APP_SECRET || "",
    debugLogRawWebhooks: process.env.DEBUG_LOG_RAW_WEBHOOKS === "true",
  },

  bot: {
    name: process.env.BOT_NAME || "Bot",
    timezone: process.env.TIMEZONE || "UTC",
    digestLookbackDays: Number(process.env.DIGEST_LOOKBACK_DAYS || 30),
    digestCron: process.env.DIGEST_CRON || "0 8 1 * *",
  },

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
  },

  google: {
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    refreshToken: required("GOOGLE_REFRESH_TOKEN"),
    calendars,
    defaultCalendar,
  },

  databaseUrl: required("DATABASE_URL"),
};
