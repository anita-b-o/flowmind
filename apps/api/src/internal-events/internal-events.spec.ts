import { matchesInternalEvent, normalizeEventTriggerFilters, sanitizeInternalEventData, type InternalEventEnvelope } from "@automation/shared-types";
import { validateExpressionString } from "@automation/expression-engine";

const envelope: InternalEventEnvelope<"DATA_STORE_RECORD_CREATED"> = {
  id: "event-1", schemaVersion: 1, type: "DATA_STORE_RECORD_CREATED", organizationId: "org-1",
  occurredAt: new Date(0).toISOString(), source: { type: "execution", id: "execution-1" },
  subject: { type: "data_store_record", id: "record-1" }, correlationId: "correlation-1",
  rootEventId: "event-1", causationId: null, depth: 0,
  data: { dataStoreId: "store-1", recordId: "record-1", key: "customers/1", version: 1, value: { name: "Ada" } }
};

describe("internal event contract", () => {
  it("redacts sensitive fields and bounds oversized strings", () => {
    const result = sanitizeInternalEventData({ authorization: "Bearer secret", nested: { api_key: "secret", safe: "x".repeat(9_000) } });
    expect(result.data).toMatchObject({ authorization: "[REDACTED]", nested: { api_key: "[REDACTED]" } });
    expect(result.omitted).toBe(true);
  });

  it("normalizes type-specific filters and rejects arbitrary operators", () => {
    expect(normalizeEventTriggerFilters("DATA_STORE_RECORD_CREATED", { dataStoreId: "store-1", keyPrefix: "customers/" })).toEqual({ dataStoreId: "store-1", keyPrefix: "customers/" });
    expect(() => normalizeEventTriggerFilters("DATA_STORE_RECORD_CREATED", { javascript: "return true" })).toThrow("Unsupported filter");
  });

  it("matches structured filters with AND semantics", () => {
    expect(matchesInternalEvent(envelope, { dataStoreId: "store-1", keyPrefix: "customers/" })).toBe(true);
    expect(matchesInternalEvent(envelope, { dataStoreId: "store-2" })).toBe(false);
  });

  it("allows trigger.event expressions without opening arbitrary trigger paths", () => {
    expect(validateExpressionString("{{trigger.event.data.key}}").valid).toBe(true);
    expect(validateExpressionString("{{trigger.credentials.secret}}").valid).toBe(false);
  });
});
