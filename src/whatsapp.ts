import crypto from "crypto";
import { config } from "./config";
import { logger } from "./logger";

const GRAPH_API_VERSION = "v21.0";

export interface IncomingMessage {
  waMessageId: string;
  groupId: string;
  senderId: string | null;
  senderName: string | null;
  text: string;
  timestampMs: number;
}

/**
 * Verifies the X-Hub-Signature-256 header Meta sends on every webhook POST,
 * so we don't act on requests that didn't actually come from Meta.
 */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!config.whatsapp.appSecret) {
    logger.warn("WHATSAPP_APP_SECRET not set - skipping webhook signature verification");
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", config.whatsapp.appSecret)
    .update(rawBody)
    .digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// The Cloud API's group-messaging feature is new and Meta's public docs on the
// exact incoming-webhook shape for group messages are sparse. This parser
// checks the field names we could confirm (individual messages) plus the
// most likely spots for a group identifier, and falls back to logging the
// raw payload so it can be adjusted once real traffic is observed - see
// README "Confirming the group webhook shape".
export function parseIncomingMessages(body: any): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const entries = body?.entry ?? [];

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value?.messages) continue;

      const contactsByWaId = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        if (contact?.wa_id) contactsByWaId.set(contact.wa_id, contact?.profile?.name ?? null);
      }

      for (const message of value.messages) {
        if (message.type !== "text" || !message.text?.body) {
          logger.info(`Ignoring non-text message of type "${message.type}"`);
          continue;
        }

        const groupId: string | undefined =
          message.group_id ?? message.context?.group_id ?? value.metadata?.group_id;

        if (!groupId) {
          logger.warn(
            "Could not find a group id on incoming message - treating sender as the conversation id. " +
              "Check DEBUG_LOG_RAW_WEBHOOKS output and adjust parseIncomingMessages() if needed.",
            message.id
          );
        }

        out.push({
          waMessageId: message.id,
          groupId: groupId ?? message.from,
          senderId: message.from ?? null,
          senderName: contactsByWaId.get(message.from) ?? null,
          text: message.text.body,
          timestampMs: Number(message.timestamp) * 1000,
        });
      }
    }
  }

  return out;
}

export async function sendGroupMessage(groupId: string, text: string): Promise<void> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "group",
      to: groupId,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${errBody}`);
  }
}
