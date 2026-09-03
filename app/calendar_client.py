from datetime import datetime, timedelta
from typing import Optional

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from app.config import config

SCOPES = ["https://www.googleapis.com/auth/calendar"]


def _get_service():
    creds = Credentials(
        token=None,
        refresh_token=config.google.refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=config.google.client_id,
        client_secret=config.google.client_secret,
        scopes=SCOPES,
    )
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def _resolve_calendar_id(calendar_name: Optional[str]) -> str:
    name = (calendar_name or config.google.default_calendar).lower()
    calendar_id = config.google.calendars.get(name)
    if not calendar_id:
        known = ", ".join(config.google.calendars.keys())
        raise ValueError(f'Unknown calendar "{name}". Configured calendars: {known}')
    return calendar_id


def list_events(calendar_name: Optional[str], start_iso: str, end_iso: str) -> list:
    calendar_id = _resolve_calendar_id(calendar_name)
    service = _get_service()

    result = (
        service.events()
        .list(
            calendarId=calendar_id,
            timeMin=start_iso,
            timeMax=end_iso,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )

    events = []
    for event in result.get("items", []):
        start = event.get("start", {})
        end = event.get("end", {})
        events.append(
            {
                "title": event.get("summary", "(no title)"),
                "start": start.get("dateTime") or start.get("date"),
                "end": end.get("dateTime") or end.get("date"),
                "location": event.get("location"),
            }
        )
    return events


def create_event(
    calendar_name: Optional[str],
    title: str,
    start_iso: str,
    end_iso: Optional[str] = None,
    description: Optional[str] = None,
    location: Optional[str] = None,
) -> dict:
    calendar_id = _resolve_calendar_id(calendar_name)
    service = _get_service()

    start_dt = datetime.fromisoformat(start_iso)
    end_dt = datetime.fromisoformat(end_iso) if end_iso else start_dt + timedelta(hours=1)

    body = {
        "summary": title,
        "description": description,
        "location": location,
        "start": {"dateTime": start_dt.isoformat(), "timeZone": config.bot.timezone},
        "end": {"dateTime": end_dt.isoformat(), "timeZone": config.bot.timezone},
    }

    created = service.events().insert(calendarId=calendar_id, body=body).execute()

    return {
        "title": created.get("summary", title),
        "start": created.get("start", {}).get("dateTime"),
        "end": created.get("end", {}).get("dateTime"),
        "location": created.get("location"),
    }


def list_configured_calendar_names() -> list:
    return list(config.google.calendars.keys())
