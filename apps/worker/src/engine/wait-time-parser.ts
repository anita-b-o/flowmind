export function parseDurationMs(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Delay duration must be a positive number of milliseconds");
    return Math.trunc(value);
  }
  if (typeof value !== "string") {
    throw new Error("Delay duration must be a string or number");
  }
  const match = value.trim().match(/^([1-9][0-9]*)\s+(second|seconds|minute|minutes|hour|hours)$/i);
  if (!match) {
    throw new Error("Delay duration must use seconds, minutes, or hours");
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("second")) return amount * 1000;
  if (unit.startsWith("minute")) return amount * 60_000;
  return amount * 3_600_000;
}

export function parseWaitUntil(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Wait Until timestamp must be a non-empty string");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Wait Until timestamp is invalid");
  }
  return date;
}
