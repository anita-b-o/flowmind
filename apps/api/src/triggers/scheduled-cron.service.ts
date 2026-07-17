import { BadRequestException, Injectable } from "@nestjs/common";
import { DateTime } from "luxon";
import parser from "cron-parser";

const DEFAULT_MIN_INTERVAL_SECONDS = 60;
const MAX_PREVIEW_RUNS = 10;

@Injectable()
export class ScheduledCronService {
  validate(cron: string, timezone: string) {
    const normalizedCron = normalizeCron(cron);
    assertTimezone(timezone);
    const minIntervalSeconds = minimumIntervalSeconds();
    const nextRuns = this.nextRuns(normalizedCron, timezone, 3);
    if (nextRuns.length < 2) {
      throw new BadRequestException("Cron expression does not produce future runs");
    }
    const minObservedSeconds = Math.min(...nextRuns.slice(1).map((run, index) => (run.getTime() - nextRuns[index].getTime()) / 1000));
    if (minObservedSeconds < minIntervalSeconds) {
      throw new BadRequestException(`Cron frequency must be at least ${minIntervalSeconds} seconds`);
    }
    return {
      cron: normalizedCron,
      bullPattern: `0 ${normalizedCron}`,
      timezone,
      nextRunAt: nextRuns[0],
      nextRuns
    };
  }

  nextRuns(cron: string, timezone: string, count = 5, from = new Date()) {
    const normalizedCron = normalizeCron(cron);
    assertTimezone(timezone);
    const limit = Math.min(Math.max(count, 1), MAX_PREVIEW_RUNS);
    try {
      const interval = parser.parseExpression(normalizedCron, {
        currentDate: from,
        tz: timezone
      });
      return Array.from({ length: limit }, () => interval.next().toDate());
    } catch (error) {
      throw new BadRequestException(cronErrorMessage(error));
    }
  }

  nextAfter(cron: string, timezone: string, after: Date) {
    return this.nextRuns(cron, timezone, 1, new Date(after.getTime() + 1000))[0];
  }
}

function normalizeCron(value: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new BadRequestException("Cron expression is required");
  }
  const fields = trimmed.split(" ");
  if (fields.length !== 5) {
    throw new BadRequestException("Use standard cron with 5 fields: minute hour day-of-month month day-of-week");
  }
  try {
    parser.parseExpression(trimmed, { currentDate: new Date() });
  } catch (error) {
    throw new BadRequestException(cronErrorMessage(error));
  }
  return trimmed;
}

function assertTimezone(timezone: string) {
  if (!timezone || !DateTime.local().setZone(timezone).isValid) {
    throw new BadRequestException("Timezone must be a valid IANA timezone");
  }
}

function minimumIntervalSeconds() {
  const value = Number(process.env.SCHEDULED_TRIGGER_MIN_INTERVAL_SECONDS ?? DEFAULT_MIN_INTERVAL_SECONDS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_INTERVAL_SECONDS;
}

function cronErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return `Invalid cron expression: ${message}`;
}
