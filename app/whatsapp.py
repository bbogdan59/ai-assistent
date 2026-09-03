import hashlib
import hmac
from typing import Optional

import requests

from app.config import config
from app.logger import get_logger

logger = get_logger(__name__)

GRAPH_API_VERSION = "v21.0"


def verify_signature(raw_body: bytes, signature_header: Optional[str]) -> bool:
    """Verifies the X-Hub-Signature-256 header Meta sends on every webhook
    POST, so we don't act on requests that didn't actually come from Meta."""
    if not config.whatsapp.app_secret:
        logger.warning("WHATSAPP_APP_SECRET not set - skipping webhook signature verification")
        return True
    if not signature_header or not signature_header.startswith("sha256="):
        return False

    expected = hmac.new(config.whatsapp.app_secret.encode(), raw_body, hashlib.sha256).hexdigest()
    provided = signature_header[len("sha256=") :]
    return hmac.compare_digest(expected, provided)


# The Cloud API's group-messaging feature is new and Meta's public docs on the
# exact incoming-webhook shape for group messages are sparse. This parser
# checks the field names we could confirm (individual messages) plus the
# most likely spots for a group identifier, and falls back to logging the
# raw payload so it can be adjusted once real traffic is observed - see
# README "Confirming the group webhook shape".
def parse_incoming_messages(body: dict) -> list:
    out = []
    entries = body.get("entry") or []

    for entry in entries:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            messages = value.get("messages")
            if not messages:
                continue

            contacts_by_wa_id = {}
            for contact in value.get("contacts") or []:
                wa_id = contact.get("wa_id")
                if wa_id:
                    contacts_by_wa_id[wa_id] = (contact.get("profile") or {}).get("name")

            for message in messages:
                if message.get("type") != "text" or not (message.get("text") or {}).get("body"):
                    logger.info('Ignoring non-text message of type "%s"', message.get("type"))
                    continue

                group_id = (
                    message.get("group_id")
                    or (message.get("context") or {}).get("group_id")
                    or (value.get("metadata") or {}).get("group_id")
                )

                if not group_id:
                    logger.warning(
                        "Could not find a group id on incoming message %s - treating sender as the "
                        "conversation id. Check DEBUG_LOG_RAW_WEBHOOKS output and adjust "
                        "parse_incoming_messages() if needed.",
                        message.get("id"),
                    )

                sender_id = message.get("from")
                out.append(
                    {
                        "wa_message_id": message.get("id"),
                        "group_id": group_id or sender_id,
                        "sender_id": sender_id,
                        "sender_name": contacts_by_wa_id.get(sender_id),
                        "text": message["text"]["body"],
                        "timestamp_ms": int(message["timestamp"]) * 1000,
                    }
                )

    return out


def send_group_message(group_id: str, text: str) -> None:
    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{config.whatsapp.phone_number_id}/messages"
    res = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {config.whatsapp.token}",
            "Content-Type": "application/json",
        },
        json={
            "messaging_product": "whatsapp",
            "recipient_type": "group",
            "to": group_id,
            "type": "text",
            "text": {"body": text},
        },
        timeout=15,
    )
    if not res.ok:
        raise RuntimeError(f"WhatsApp send failed ({res.status_code}): {res.text}")
