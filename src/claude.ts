import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { logger } from "./logger";
import { createEvent, listEvents, listConfiguredCalendarNames } from "./calendar";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const calendarNames = listConfiguredCalendarNames();

const tools: Anthropic.Tool[] = [
  {
    name: "list_calendar_events",
    description:
      "List events on a shared calendar between two points in time. Use this whenever the user asks what's on the calendar, whether they're free, or about a specific day/evening.",
    input_schema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          enum: calendarNames,
          description: `Which calendar to check. Defaults to "${config.google.defaultCalendar}" if omitted.`,
        },
        start: { type: "string", description: "Start of the range, ISO 8601 datetime with timezone offset." },
        end: { type: "string", description: "End of the range, ISO 8601 datetime with timezone offset." },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "create_calendar_event",
    description: "Add a new event to a shared calendar.",
    input_schema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          enum: calendarNames,
          description: `Which calendar to add the event to. Defaults to "${config.google.defaultCalendar}" if omitted.`,
        },
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 datetime with timezone offset." },
        end: { type: "string", description: "ISO 8601 datetime with timezone offset. Defaults to 1 hour after start." },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["title", "start"],
    },
  },
];

async function runTool(name: string, input: any): Promise<string> {
  try {
    if (name === "list_calendar_events") {
      const events = await listEvents({ calendarName: input.calendar, startISO: input.start, endISO: input.end });
      if (events.length === 0) return "No events found in that range.";
      return events.map((e) => `- ${e.title} (${e.start} to ${e.end}${e.location ? `, ${e.location}` : ""})`).join("\n");
    }
    if (name === "create_calendar_event") {
      const event = await createEvent({
        calendarName: input.calendar,
        title: input.title,
        startISO: input.start,
        endISO: input.end,
        description: input.description,
        location: input.location,
      });
      return `Created "${event.title}" from ${event.start} to ${event.end}.`;
    }
    return `Unknown tool: ${name}`;
  } catch (err) {
    logger.error(`Tool "${name}" failed`, err);
    return `Error running ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function systemPrompt(): string {
  const now = new Date().toLocaleString("en-US", { timeZone: config.bot.timezone });
  return `You are ${config.bot.name}, a helpful assistant in a WhatsApp group chat.
People address you by name. You have access to these shared Google calendars: ${calendarNames.join(", ")}.
The current date/time is ${now} (timezone: ${config.bot.timezone}) - use this to resolve relative references like "tonight", "tomorrow", or "this weekend" into concrete ISO datetimes before calling a tool.
When asked about a calendar, use list_calendar_events. When asked to add/schedule something, use create_calendar_event and then confirm exactly what you added, including the date and time.
Keep replies short and in plain text suitable for WhatsApp - no markdown headers, no long paragraphs.
If a question isn't about the calendar, answer briefly and helpfully, but never invent calendar events or dates - always check via the tool first.`;
}

export async function handleUserMessage(senderName: string | null, text: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `${senderName ?? "Someone"}: ${text}` },
  ];

  for (let iteration = 0; iteration < 4; iteration++) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: systemPrompt(),
      tools,
      messages,
    });

    if (response.stop_reason !== "tool_use") {
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await runTool(block.name, block.input);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return "Sorry, I got stuck trying to handle that. Try rephrasing?";
}

export async function generateDigest(transcript: string, periodLabel: string): Promise<string | null> {
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system:
      "You summarize WhatsApp group chat transcripts into a short recap for the group. " +
      "Plain text only, suitable for WhatsApp - no markdown headers, use simple line breaks and dashes.",
    messages: [
      {
        role: "user",
        content: `Here is the group chat transcript for ${periodLabel}:\n\n${transcript}\n\n` +
          `Write a short recap with up to three sections (only include a section if it has content):\n` +
          `1) Decisions that were made\n` +
          `2) Action items or things people said they'd do (mention who, if clear)\n` +
          `3) Open questions or topics raised but never resolved\n` +
          `If there's genuinely nothing worth recapping, reply with exactly: NOTHING_TO_REPORT`,
      },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (text === "NOTHING_TO_REPORT" || text.length === 0) return null;
  return text;
}
