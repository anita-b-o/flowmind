"use client";

import type { StepType } from "../../types";

const GROUPS: Array<{ label: string; items: Array<{ type: StepType; name: string; description: string; icon: string }> }> = [
  { label: "Actions", items: [{ type: "http_request", name: "HTTP Request", description: "Call an API connection.", icon: "HTTP" }] },
  { label: "Workflows", items: [
    { type: "execute_workflow", name: "Execute Workflow", description: "Invoke a published workflow.", icon: "FLOW" },
    { type: "return_workflow_output", name: "Return Output", description: "Return a controlled child output.", icon: "RET" }
  ] },
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
      { type: "for_each", name: "For Each", description: "Run a controlled body for each array item.", icon: "EACH" },
      { type: "conditional", name: "Conditional", description: "Legacy linear condition.", icon: "LEG" }
    ]
  },
  {
    label: "Waits",
    items: [
      { type: "delay", name: "Delay", description: "Pause for a duration.", icon: "DLY" },
      { type: "wait_until", name: "Wait Until", description: "Pause until a timestamp.", icon: "CLK" }
      ,{ type: "approval", name: "Approval", description: "Wait for an authorized human decision.", icon: "OK" }
    ]
  },
  {
    label: "Data",
    items: [
      { type: "transform", name: "Transform", description: "Shape data with safe expressions.", icon: "TX" },
      { type: "database_record", name: "Database Record", description: "Write a workflow record.", icon: "DB" },
      { type: "data_store_get_record", name: "Data Store Get", description: "Read persistent workflow state.", icon: "GET" },
      { type: "data_store_upsert_record", name: "Data Store Upsert", description: "Create or update a record.", icon: "PUT" },
      { type: "data_store_delete_record", name: "Data Store Delete", description: "Soft delete a record.", icon: "DEL" },
      { type: "data_store_exists_record", name: "Data Store Exists", description: "Check whether a key exists.", icon: "EX" },
      { type: "data_store_count_records", name: "Data Store Count", description: "Count records.", icon: "#" },
      { type: "data_store_list_records", name: "Data Store List", description: "Page through records.", icon: "LS" },
      { type: "set_variable", name: "Set Variable", description: "Create or overwrite a runtime variable.", icon: "SET" },
      { type: "get_variable", name: "Get Variable", description: "Read a runtime variable.", icon: "GET" },
      { type: "delete_variable", name: "Delete Variable", description: "Remove a runtime variable.", icon: "DEL" },
      { type: "increment_variable", name: "Increment Variable", description: "Increment a numeric variable.", icon: "+1" },
      { type: "append_variable", name: "Append Variable", description: "Append an item to an array variable.", icon: "ADD" },
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
