import { Pool } from "pg";
import { config } from "./config";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
});

export async function initDb(): Promise<void> {
  await pool.query(`
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
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages (group_id, wa_timestamp);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS digest_runs (
      id BIGSERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export interface StoredMessage {
  waMessageId: string | null;
  groupId: string;
  senderId: string | null;
  senderName: string | null;
  body: string;
  timestampMs: number;
}

export async function saveMessage(msg: StoredMessage): Promise<void> {
  await pool.query(
    `INSERT INTO messages (wa_message_id, group_id, sender_id, sender_name, body, wa_timestamp)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000))
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [msg.waMessageId, msg.groupId, msg.senderId, msg.senderName, msg.body, msg.timestampMs]
  );
}

export interface MessageRow {
  sender_name: string | null;
  body: string;
  wa_timestamp: Date;
}

export async function getMessagesSince(groupId: string, since: Date): Promise<MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT sender_name, body, wa_timestamp
     FROM messages
     WHERE group_id = $1 AND wa_timestamp >= $2
     ORDER BY wa_timestamp ASC`,
    [groupId, since]
  );
  return result.rows;
}

export async function getDistinctActiveGroups(since: Date): Promise<string[]> {
  const result = await pool.query<{ group_id: string }>(
    `SELECT DISTINCT group_id FROM messages WHERE wa_timestamp >= $1`,
    [since]
  );
  return result.rows.map((r) => r.group_id);
}

export async function getLastDigestRun(groupId: string): Promise<Date | null> {
  const result = await pool.query<{ period_end: Date }>(
    `SELECT period_end FROM digest_runs WHERE group_id = $1 ORDER BY period_end DESC LIMIT 1`,
    [groupId]
  );
  return result.rows[0]?.period_end ?? null;
}

export async function recordDigestRun(groupId: string, periodStart: Date, periodEnd: Date): Promise<void> {
  await pool.query(
    `INSERT INTO digest_runs (group_id, period_start, period_end) VALUES ($1, $2, $3)`,
    [groupId, periodStart, periodEnd]
  );
}
