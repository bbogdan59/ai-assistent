from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.claude_client import generate_digest
from app.config import config
from app.db import get_distinct_active_groups, get_last_digest_run, get_messages_since, record_digest_run
from app.logger import get_logger
from app.whatsapp import send_group_message

logger = get_logger(__name__)


def _build_transcript(rows: list) -> str:
    lines = []
    for row in rows:
        body = (row.get("body") or "").strip()
        if not body:
            continue
        lines.append(f"{row.get('sender_name') or 'Someone'}: {body}")
    return "\n".join(lines)


def run_digest_for_group(group_id: str, period_start: datetime, period_end: datetime, notify_if_empty: bool) -> None:
    rows = get_messages_since(group_id, period_start)

    if len(rows) < 3:
        if notify_if_empty:
            send_group_message(group_id, "Not much happened in the last month worth recapping!")
        record_digest_run(group_id, period_start, period_end)
        return

    transcript = _build_transcript(rows)
    period_label = f"{period_start.strftime('%Y-%m-%d')} to {period_end.strftime('%Y-%m-%d')}"
    summary = generate_digest(transcript, period_label)

    if not summary:
        if notify_if_empty:
            send_group_message(group_id, "Went through the last month's chat - nothing that needs follow-up!")
    else:
        send_group_message(group_id, f"Recap - {period_label}\n\n{summary}")

    record_digest_run(group_id, period_start, period_end)


def run_manual_recap(group_id: str) -> None:
    since = datetime.now(timezone.utc) - timedelta(days=config.bot.digest_lookback_days)
    run_digest_for_group(group_id, since, datetime.now(timezone.utc), notify_if_empty=True)


def _run_scheduled_digests() -> None:
    logger.info("Running scheduled monthly digest")
    default_since = datetime.now(timezone.utc) - timedelta(days=config.bot.digest_lookback_days)
    groups = get_distinct_active_groups(default_since)

    for group_id in groups:
        try:
            last_run = get_last_digest_run(group_id)
            period_start = last_run if last_run and last_run > default_since else default_since
            run_digest_for_group(group_id, period_start, datetime.now(timezone.utc), notify_if_empty=False)
        except Exception as err:  # noqa: BLE001
            logger.error("Monthly digest failed for group %s: %s", group_id, err)


def schedule_monthly_digests() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(_run_scheduled_digests, CronTrigger.from_crontab(config.bot.digest_cron))
    scheduler.start()
    logger.info('Monthly digest scheduled with cron "%s" (UTC)', config.bot.digest_cron)
    return scheduler
