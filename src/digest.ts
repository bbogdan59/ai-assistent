import cron from "node-cron";
import { config } from "./config";
import { logger } from "./logger";
import { getDistinctActiveGroups, getLastDigestRun, getMessagesSince, recordDigestRun } from "./db";
import { generateDigest } from "./claude";
import { sendGroupMessage } from "./whatsapp";

function buildTranscript(rows: { sender_name: string | null; body: string }[]): string {
  return rows
    .filter((r) => r.body?.trim())
    .map((r) => `${r.sender_name ?? "Someone"}: ${r.body}`)
    .join("\n");
}

export async function runDigestForGroup(
  groupId: string,
  periodStart: Date,
  periodEnd: Date,
  options: { notifyIfEmpty: boolean }
): Promise<void> {
  const rows = await getMessagesSince(groupId, periodStart);

  if (rows.length < 3) {
    if (options.notifyIfEmpty) {
      await sendGroupMessage(groupId, "Not much happened in the last month worth recapping!");
    }
    await recordDigestRun(groupId, periodStart, periodEnd);
    return;
  }

  const transcript = buildTranscript(rows);
  const periodLabel = `${periodStart.toDateString()} to ${periodEnd.toDateString()}`;
  const summary = await generateDigest(transcript, periodLabel);

  if (!summary) {
    if (options.notifyIfEmpty) {
      await sendGroupMessage(groupId, "Went through the last month's chat - nothing that needs follow-up!");
    }
  } else {
    await sendGroupMessage(groupId, `Recap - ${periodLabel}\n\n${summary}`);
  }

  await recordDigestRun(groupId, periodStart, periodEnd);
}

export async function runManualRecap(groupId: string): Promise<void> {
  const since = new Date(Date.now() - config.bot.digestLookbackDays * 24 * 60 * 60 * 1000);
  await runDigestForGroup(groupId, since, new Date(), { notifyIfEmpty: true });
}

export function scheduleMonthlyDigests(): void {
  cron.schedule(config.bot.digestCron, async () => {
    logger.info("Running scheduled monthly digest");
    const defaultSince = new Date(Date.now() - config.bot.digestLookbackDays * 24 * 60 * 60 * 1000);
    const groups = await getDistinctActiveGroups(defaultSince);

    for (const groupId of groups) {
      try {
        const lastRun = await getLastDigestRun(groupId);
        const periodStart = lastRun && lastRun > defaultSince ? lastRun : defaultSince;
        await runDigestForGroup(groupId, periodStart, new Date(), { notifyIfEmpty: false });
      } catch (err) {
        logger.error(`Monthly digest failed for group ${groupId}`, err);
      }
    }
  });
  logger.info(`Monthly digest scheduled with cron "${config.bot.digestCron}" (${config.bot.timezone === "UTC" ? "UTC" : "server time, UTC in Docker"})`);
}
