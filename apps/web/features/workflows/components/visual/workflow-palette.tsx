"use client";

import type { StepType } from "../../types";

const GROUPS: Array<{ label: string; items: Array<{ type: StepType; name: string; description: string; icon: string }> }> = [
  { label: "Actions", items: [{ type: "http_request", name: "HTTP Request", description: "Call an API connection.", icon: "HTTP" }] },
  {
    label: "AI",
    items: [
      { type: "ai_classification", name: "AI Classification", description: "Classify text into labels.", icon: "AI" },
      { type: "ai_structured_extraction", name: "AI Extraction", description: "Extract structured JSON.", icon: "JSON" },
      { type: "ai_summary", name: "AI Summary", description: "Summarize text safely.", icon: "TXT" }
    ]
  },
  {
    label: "Logic",
    items: [
      { type: "if", name: "If", description: "Route true and false branches.", icon: "IF" },
      { type: "switch", name: "Switch", description: "Route cases plus default.", icon: "SW" },
      { type: "conditional", name: "Conditional", description: "Legacy linear condition.", icon: "LEG" }
    ]
  },
  {
    label: "Waits",
    items: [
      { type: "delay", name: "Delay", description: "Pause for a duration.", icon: "DLY" },
      { type: "wait_until", name: "Wait Until", description: "Pause until a timestamp.", icon: "CLK" }
    ]
  },
  {
    label: "Data",
    items: [
      { type: "database_record", name: "Database Record", description: "Write a workflow record.", icon: "DB" },
      { type: "email_notification", name: "Email", description: "Send via SMTP connection.", icon: "MAIL" }
    ]
  }
];

export function WorkflowPalette({ disabled, onAdd }: { disabled: boolean; onAdd: (type: StepType) => void }) {
  return (
    <aside className="workflow-palette" aria-label="Workflow node palette">
      <h3>Palette</h3>
      {GROUPS.map((group) => (
        <section key={group.label} className="workflow-palette-group">
          <strong>{group.label}</strong>
          {group.items.map((item) => (
            <button key={item.type} type="button" disabled={disabled} className="workflow-palette-item" onClick={() => onAdd(item.type)}>
              <span className="workflow-palette-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>
                <strong>{item.name}</strong>
                <span className="muted">{item.description}</span>
              </span>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
