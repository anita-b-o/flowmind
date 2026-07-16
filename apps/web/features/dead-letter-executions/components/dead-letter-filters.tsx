"use client";

import { DEAD_LETTER_REASONS, reasonLabels } from "../reasons";
import type { DeadLetterFilters } from "../hooks";
import type { DeadLetterStatusFilter } from "../types";

export function DeadLetterFilters({
  filters,
  onChange
}: {
  filters: DeadLetterFilters;
  onChange: (filters: DeadLetterFilters) => void;
}) {
  return (
    <section className="panel stack">
      <div className="grid">
        <label>
          State
          <select value={filters.status ?? ""} onChange={(event) => onChange({ ...filters, status: event.target.value as DeadLetterStatusFilter })}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label>
          Reason
          <select value={filters.reason ?? ""} onChange={(event) => onChange({ ...filters, reason: event.target.value })}>
            <option value="">All reasons</option>
            {DEAD_LETTER_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reasonLabels[reason]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Workflow ID
          <input value={filters.workflowId ?? ""} onChange={(event) => onChange({ ...filters, workflowId: event.target.value })} />
        </label>
        <label>
          From
          <input type="date" value={filters.from ?? ""} onChange={(event) => onChange({ ...filters, from: event.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={filters.to ?? ""} onChange={(event) => onChange({ ...filters, to: event.target.value })} />
        </label>
      </div>
    </section>
  );
}
