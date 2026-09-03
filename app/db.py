from contextlib import contextmanager
from datetime import datetime
from typing import Optional

import psycopg2
from psycopg2 import pool as pg_pool
from psycopg2.extras import RealDictCursor

from app.config import config

_sslmode = "disable" if "localhost" in config.database_url or "127.0.0.1" in config.database_url else "require"

_pool = pg_pool.ThreadedConnectionPool(1, 10, dsn=config.database_url, sslmode=_sslmode)


@contextmanager
def _cursor(commit: bool = False):
    conn = _pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            yield cur
        if commit:
            conn.commit()
    finally:
        _pool.putconn(conn)


def init_db() -> None:
    with _cursor(commit=True) as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id BIGSERIAL PRIMARY KEY,
                wa_message_id TEXT UNIQUE,
                group_id TEXT NOT NULL,
                sender_id TEXT,
                sender_name TEXT,
                body TEXT,
                wa_timestamp TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages (group_id, wa_timestamp);"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS digest_runs (
                id BIGSERIAL PRIMARY KEY,
                group_id TEXT NOT NULL,
                period_start TIMESTAMPTZ NOT NULL,
                period_end TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            """
        )


def save_message(
    wa_message_id: Optional[str],
    group_id: str,
    sender_id: Optional[str],
    sender_name: Optional[str],
    body: str,
    timestamp_ms: int,
) -> None:
    with _cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO messages (wa_message_id, group_id, sender_id, sender_name, body, wa_timestamp)
            VALUES (%s, %s, %s, %s, %s, to_timestamp(%s::double precision / 1000))
            ON CONFLICT (wa_message_id) DO NOTHING
            """,
            (wa_message_id, group_id, sender_id, sender_name, body, timestamp_ms),
        )


def get_messages_since(group_id: str, since: datetime) -> list:
    with _cursor() as cur:
        cur.execute(
            """
            SELECT sender_name, body, wa_timestamp
            FROM messages
            WHERE group_id = %s AND wa_timestamp >= %s
            ORDER BY wa_timestamp ASC
            """,
            (group_id, since),
        )
        return cur.fetchall()


def get_distinct_active_groups(since: datetime) -> list:
    with _cursor() as cur:
        cur.execute("SELECT DISTINCT group_id FROM messages WHERE wa_timestamp >= %s", (since,))
        return [row["group_id"] for row in cur.fetchall()]


def get_last_digest_run(group_id: str) -> Optional[datetime]:
    with _cursor() as cur:
        cur.execute(
            "SELECT period_end FROM digest_runs WHERE group_id = %s ORDER BY period_end DESC LIMIT 1",
            (group_id,),
        )
        row = cur.fetchone()
        return row["period_end"] if row else None


def record_digest_run(group_id: str, period_start: datetime, period_end: datetime) -> None:
    with _cursor(commit=True) as cur:
        cur.execute(
            "INSERT INTO digest_runs (group_id, period_start, period_end) VALUES (%s, %s, %s)",
            (group_id, period_start, period_end),
        )
