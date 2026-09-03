import { google } from "googleapis";
import { config } from "./config";

function getAuthClient() {
  const client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  client.setCredentials({ refresh_token: config.google.refreshToken });
  return client;
}

function resolveCalendarId(calendarName?: string): { id: string; name: string } {
  const name = (calendarName || config.google.defaultCalendar).toLowerCase();
  const id = config.google.calendars[name];
  if (!id) {
    const known = Object.keys(config.google.calendars).join(", ");
    throw new Error(`Unknown calendar "${name}". Configured calendars: ${known}`);
  }
  return { id, name };
}

export interface CalendarEvent {
  title: string;
  start: string | null;
  end: string | null;
  location: string | null;
}

export async function listEvents(args: {
  calendarName?: string;
  startISO: string;
  endISO: string;
}): Promise<CalendarEvent[]> {
  const { id } = resolveCalendarId(args.calendarName);
  const calendar = google.calendar({ version: "v3", auth: getAuthClient() });

  const res = await calendar.events.list({
    calendarId: id,
    timeMin: args.startISO,
    timeMax: args.endISO,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items ?? []).map((event) => ({
    title: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    location: event.location ?? null,
  }));
}

export async function createEvent(args: {
  calendarName?: string;
  title: string;
  startISO: string;
  endISO?: string;
  description?: string;
  location?: string;
}): Promise<CalendarEvent> {
  const { id } = resolveCalendarId(args.calendarName);
  const calendar = google.calendar({ version: "v3", auth: getAuthClient() });

  const start = new Date(args.startISO);
  const end = args.endISO ? new Date(args.endISO) : new Date(start.getTime() + 60 * 60 * 1000);

  const res = await calendar.events.insert({
    calendarId: id,
    requestBody: {
      summary: args.title,
      description: args.description,
      location: args.location,
      start: { dateTime: start.toISOString(), timeZone: config.bot.timezone },
      end: { dateTime: end.toISOString(), timeZone: config.bot.timezone },
    },
  });

  return {
    title: res.data.summary ?? args.title,
    start: res.data.start?.dateTime ?? null,
    end: res.data.end?.dateTime ?? null,
    location: res.data.location ?? null,
  };
}

export function listConfiguredCalendarNames(): string[] {
  return Object.keys(config.google.calendars);
}
