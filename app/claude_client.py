from datetime import datetime
from zoneinfo import ZoneInfo

import anthropic

from app.calendar_client import create_event, list_configured_calendar_names, list_events
from app.config import config
from app.logger import get_logger

logger = get_logger(__name__)

client = anthropic.Anthropic(api_key=config.anthropic.api_key)

CALENDAR_NAMES = list_configured_calendar_names()

TOOLS = [
    {
        "name": "list_calendar_events",
        "description": (
            "List events on a shared calendar between two points in time. Use this whenever the "
            "user asks what's on the calendar, whether they're free, or about a specific day/evening."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "calendar": {
                    "type": "string",
                    "enum": CALENDAR_NAMES,
                    "description": f'Which calendar to check. Defaults to "{config.google.default_calendar}" if omitted.',
                },
                "start": {"type": "string", "description": "Start of the range, ISO 8601 datetime with timezone offset."},
                "end": {"type": "string", "description": "End of the range, ISO 8601 datetime with timezone offset."},
            },
            "required": ["start", "end"],
        },
    },
    {
        "name": "create_calendar_event",
        "description": "Add a new event to a shared calendar.",
        "input_schema": {
            "type": "object",
            "properties": {
                "calendar": {
                    "type": "string",
                    "enum": CALENDAR_NAMES,
                    "description": f'Which calendar to add the event to. Defaults to "{config.google.default_calendar}" if omitted.',
                },
                "title": {"type": "string"},
                "start": {"type": "string", "description": "ISO 8601 datetime with timezone offset."},
                "end": {
                    "type": "string",
                    "description": "ISO 8601 datetime with timezone offset. Defaults to 1 hour after start.",
                },
                "description": {"type": "string"},
                "location": {"type": "string"},
            },
            "required": ["title", "start"],
        },
    },
]


def _run_tool(name: str, tool_input: dict) -> str:
    try:
        if name == "list_calendar_events":
            events = list_events(tool_input.get("calendar"), tool_input["start"], tool_input["end"])
            if not events:
                return "No events found in that range."
            lines = []
            for e in events:
                location = f", {e['location']}" if e.get("location") else ""
                lines.append(f"- {e['title']} ({e['start']} to {e['end']}{location})")
            return "\n".join(lines)

        if name == "create_calendar_event":
            event = create_event(
                calendar_name=tool_input.get("calendar"),
                title=tool_input["title"],
                start_iso=tool_input["start"],
                end_iso=tool_input.get("end"),
                description=tool_input.get("description"),
                location=tool_input.get("location"),
            )
            return f"Created \"{event['title']}\" from {event['start']} to {event['end']}."

        return f"Unknown tool: {name}"
    except Exception as err:  # noqa: BLE001 - reported back to Claude, not raised
        logger.error('Tool "%s" failed: %s', name, err)
        return f"Error running {name}: {err}"


def _system_prompt() -> str:
    now = datetime.now(ZoneInfo(config.bot.timezone)).strftime("%A, %Y-%m-%d %H:%M %Z")
    return (
        f"You are {config.bot.name}, a helpful assistant in a WhatsApp group chat.\n"
        f"People address you by name. You have access to these shared Google calendars: {', '.join(CALENDAR_NAMES)}.\n"
        f"The current date/time is {now} (timezone: {config.bot.timezone}) - use this to resolve relative "
        f"references like \"tonight\", \"tomorrow\", or \"this weekend\" into concrete ISO datetimes before "
        f"calling a tool.\n"
        f"When asked about a calendar, use list_calendar_events. When asked to add/schedule something, use "
        f"create_calendar_event and then confirm exactly what you added, including the date and time.\n"
        f"Keep replies short and in plain text suitable for WhatsApp - no markdown headers, no long paragraphs.\n"
        f"If a question isn't about the calendar, answer briefly and helpfully, but never invent calendar "
        f"events or dates - always check via the tool first."
    )


def handle_user_message(sender_name: str, text: str) -> str:
    messages = [{"role": "user", "content": f"{sender_name or 'Someone'}: {text}"}]

    for _ in range(4):
        response = client.messages.create(
            model=config.anthropic.model,
            max_tokens=1024,
            system=_system_prompt(),
            tools=TOOLS,
            messages=messages,
        )

        if response.stop_reason != "tool_use":
            return "\n".join(block.text for block in response.content if block.type == "text").strip()

        assistant_content = [
            {"type": "text", "text": block.text}
            if block.type == "text"
            else {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
            for block in response.content
        ]
        messages.append({"role": "assistant", "content": assistant_content})

        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                result = _run_tool(block.name, block.input)
                tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": result})
        messages.append({"role": "user", "content": tool_results})

    return "Sorry, I got stuck trying to handle that. Try rephrasing?"


def generate_digest(transcript: str, period_label: str) -> str | None:
    response = client.messages.create(
        model=config.anthropic.model,
        max_tokens=1024,
        system=(
            "You summarize WhatsApp group chat transcripts into a short recap for the group. "
            "Plain text only, suitable for WhatsApp - no markdown headers, use simple line breaks and dashes."
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Here is the group chat transcript for {period_label}:\n\n{transcript}\n\n"
                    "Write a short recap with up to three sections (only include a section if it has content):\n"
                    "1) Decisions that were made\n"
                    "2) Action items or things people said they'd do (mention who, if clear)\n"
                    "3) Open questions or topics raised but never resolved\n"
                    "If there's genuinely nothing worth recapping, reply with exactly: NOTHING_TO_REPORT"
                ),
            }
        ],
    )

    text = "\n".join(block.text for block in response.content if block.type == "text").strip()
    if text == "NOTHING_TO_REPORT" or not text:
        return None
    return text
