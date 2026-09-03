import os
from dotenv import load_dotenv

load_dotenv()


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _parse_calendars(raw: str) -> dict:
    calendars = {}
    for pair in raw.split(","):
        trimmed = pair.strip()
        if not trimmed:
            continue
        if ":" not in trimmed:
            raise RuntimeError(f'Invalid CALENDARS entry "{trimmed}" - expected format name:calendarId')
        name, calendar_id = trimmed.split(":", 1)
        calendars[name.strip().lower()] = calendar_id.strip()
    return calendars


class WhatsAppConfig:
    def __init__(self):
        self.token = _required("WHATSAPP_TOKEN")
        self.phone_number_id = _required("WHATSAPP_PHONE_NUMBER_ID")
        self.verify_token = _required("WHATSAPP_VERIFY_TOKEN")
        self.app_secret = os.environ.get("WHATSAPP_APP_SECRET", "")
        self.debug_log_raw_webhooks = os.environ.get("DEBUG_LOG_RAW_WEBHOOKS", "false").lower() == "true"


class BotConfig:
    def __init__(self):
        self.name = os.environ.get("BOT_NAME", "Bot")
        self.timezone = os.environ.get("TIMEZONE", "UTC")
        self.digest_lookback_days = int(os.environ.get("DIGEST_LOOKBACK_DAYS", "30"))
        self.digest_cron = os.environ.get("DIGEST_CRON", "0 8 1 * *")


class AnthropicConfig:
    def __init__(self):
        self.api_key = _required("ANTHROPIC_API_KEY")
        self.model = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5")


class GoogleConfig:
    def __init__(self):
        self.client_id = _required("GOOGLE_CLIENT_ID")
        self.client_secret = _required("GOOGLE_CLIENT_SECRET")
        self.refresh_token = _required("GOOGLE_REFRESH_TOKEN")
        self.calendars = _parse_calendars(_required("CALENDARS"))
        default_calendar = os.environ.get("DEFAULT_CALENDAR", next(iter(self.calendars), "")).lower()
        if default_calendar not in self.calendars:
            known = ", ".join(self.calendars.keys())
            raise RuntimeError(f'DEFAULT_CALENDAR "{default_calendar}" is not one of the configured CALENDARS: {known}')
        self.default_calendar = default_calendar


class Config:
    def __init__(self):
        self.port = int(os.environ.get("PORT", "3000"))
        self.whatsapp = WhatsAppConfig()
        self.bot = BotConfig()
        self.anthropic = AnthropicConfig()
        self.google = GoogleConfig()
        self.database_url = _required("DATABASE_URL")


config = Config()
