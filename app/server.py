import re
import threading

from flask import Flask, request

from app.claude_client import handle_user_message
from app.config import config
from app.db import init_db, save_message
from app.digest import run_manual_recap, schedule_monthly_digests
from app.logger import get_logger
from app.whatsapp import parse_incoming_messages, send_group_message, verify_signature

logger = get_logger(__name__)

app = Flask(__name__)

ADDRESSED_TO_BOT_RE = re.compile(r"\b" + re.escape(config.bot.name) + r"\b", re.IGNORECASE)
RECAP_KEYWORD_RE = re.compile(r"\b(recap|summary|summarize)\b", re.IGNORECASE)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/webhook")
def verify_webhook():
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge", "")

    if mode == "subscribe" and token == config.whatsapp.verify_token:
        return challenge, 200
    return "", 403


@app.post("/webhook")
def receive_webhook():
    raw_body = request.get_data()
    signature = request.headers.get("X-Hub-Signature-256")

    if not verify_signature(raw_body, signature):
        logger.warning("Rejected webhook POST with invalid signature")
        return "", 401

    body = request.get_json(silent=True) or {}

    # Ack immediately - Meta expects a fast 200, and we don't want retries
    # piling up while Claude/Calendar calls are in flight.
    threading.Thread(target=_process_webhook_body, args=(body,), daemon=True).start()
    return "", 200


def _process_webhook_body(body: dict) -> None:
    if config.whatsapp.debug_log_raw_webhooks:
        logger.info("Raw webhook payload: %s", body)

    try:
        messages = parse_incoming_messages(body)
    except Exception as err:  # noqa: BLE001
        logger.error("Failed to parse webhook body: %s", err)
        return

    for message in messages:
        try:
            save_message(
                wa_message_id=message["wa_message_id"],
                group_id=message["group_id"],
                sender_id=message["sender_id"],
                sender_name=message["sender_name"],
                body=message["text"],
                timestamp_ms=message["timestamp_ms"],
            )
        except Exception as err:  # noqa: BLE001
            logger.error("Failed to save message: %s", err)

        _handle_if_addressed_to_bot(message)


def _handle_if_addressed_to_bot(message: dict) -> None:
    if not ADDRESSED_TO_BOT_RE.search(message["text"]):
        return

    group_id = message["group_id"]
    try:
        if RECAP_KEYWORD_RE.search(message["text"]):
            run_manual_recap(group_id)
            return

        reply = handle_user_message(message["sender_name"], message["text"])
        if reply:
            send_group_message(group_id, reply)
    except Exception as err:  # noqa: BLE001
        logger.error("Failed to handle message addressed to bot: %s", err)
        try:
            send_group_message(group_id, "Sorry, something went wrong handling that - please try again.")
        except Exception as send_err:  # noqa: BLE001
            logger.error("Failed to send error reply: %s", send_err)


init_db()
schedule_monthly_digests()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=config.port)
