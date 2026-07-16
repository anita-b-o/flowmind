import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeadLetterTable } from "./dead-letter-table";

describe("DeadLetterTable", () => {
  it("renders active and resolved DLQ rows without raw IDs as the only signal", () => {
    render(
      <DeadLetterTable
        items={[
          {
            id: "dlq-1",
            executionId: "execution-123456",
            workflowId: "workflow-1",
            workflowName: "Lead intake",
            workflowVersionId: "version-1",
            failedStepKey: "notify",
            reason: "ambiguous_effect",
            attempts: 3,
            active: true,
            createdAt: new Date().toISOString(),
            resolvedAt: null,
            resolution: null,
            retryExecutionId: null,
            correlationId: "correlation-1"
          }
        ]}
      />
    );

    expect(screen.getByText("DLQ ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("Ambiguous effect")).toBeInTheDocument();
    expect(screen.getByText("Lead intake")).toBeInTheDocument();
    expect(screen.getByText("notify")).toBeInTheDocument();
  });
});
