import express, { Request, Response } from "express";
import { config } from "./config";
import { logger } from "./logger";
import { initDb, saveMessage } from "./db";
import { parseIncomingMessages, sendGroupMessage, verifySignature, IncomingMessage } from "./whatsapp";
import { handleUserMessage } from "./claude";
import { runManualRecap, scheduleMonthlyDigests } from "./digest";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const addressedToBotRegex = new RegExp(`\\b${escapeRegExp(config.bot.name)}\\b`, "i");
const recapKeywordRegex = /\b(recap|summary|summarize)\b/i;

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const signature = req.header("x-hub-signature-256");

  if (!rawBody || !verifySignature(rawBody, signature)) {
    logger.warn("Rejected webhook POST with invalid signature");
    res.sendStatus(401);
    return;
  }

  // Ack immediately - Meta expects a fast 200, and we don't want retries
  // piling up while Claude/Calendar calls are in flight.
  res.sendStatus(200);

  processWebhookBody(req.body).catch((err) => logger.error("Failed to process webhook body", err));
});

async function processWebhookBody(body: unknown): Promise<void> {
  if (config.whatsapp.debugLogRawWebhooks) {
    logger.info("Raw webhook payload:", JSON.stringify(body));
  }

  const messages = parseIncomingMessages(body);

  for (const message of messages) {
    await saveMessage({
      waMessageId: message.waMessageId,
      groupId: message.groupId,
      senderId: message.senderId,
      senderName: message.senderName,
      body: message.text,
      timestampMs: message.timestampMs,
    });
    await handleIfAddressedToBot(message);
  }
}

async function handleIfAddressedToBot(message: IncomingMessage): Promise<void> {
  if (!addressedToBotRegex.test(message.text)) return;

  try {
    if (recapKeywordRegex.test(message.text)) {
      await runManualRecap(message.groupId);
      return;
    }

    const reply = await handleUserMessage(message.senderName, message.text);
    if (reply) {
      await sendGroupMessage(message.groupId, reply);
    }
  } catch (err) {
    logger.error("Failed to handle message addressed to bot", err);
    try {
      await sendGroupMessage(message.groupId, "Sorry, something went wrong handling that - please try again.");
    } catch (sendErr) {
      logger.error("Failed to send error reply", sendErr);
    }
  }
}

async function main(): Promise<void> {
  await initDb();
  scheduleMonthlyDigests();
  app.listen(config.port, () => logger.info(`Listening on port ${config.port}`));
}

main().catch((err) => {
  logger.error("Fatal startup error", err);
  process.exit(1);
});
