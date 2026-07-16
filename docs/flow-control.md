# Advanced Flow Control

Flowmind supports graph-backed workflow versions with `workflowDefinitionSchemaVersion: 2`. The public `steps[]` array remains flat for compatibility, while `definitionJson.graph` stores routing:

```json
{
  "entryStepKey": "route",
  "edges": [
    { "from": "route", "to": "vip", "kind": "if_true", "label": "true" },
    { "from": "route", "to": "normal", "kind": "if_false", "label": "false" },
    { "from": "vip", "to": "normal", "kind": "next" }
  ],
  "terminalStepKeys": ["normal"]
}
```

Visual workflow editor metadata is stored separately in `definitionJson.ui`. Positions, viewport and collapsed state are presentation-only and must not affect runner semantics:

```json
{
  "ui": {
    "nodes": {
      "route": { "x": 260, "y": 40 }
    },
    "viewport": { "x": 0, "y": 0, "zoom": 1 }
  }
}
```

Supported control steps:

- `if`: evaluates `left/operator/right` and routes to `trueStepKey` or `falseStepKey`.
- `switch`: evaluates `value`, routes to the first exact matching case, otherwise `defaultStepKey`.
- `delay`: accepts positive durations such as `30 seconds`, `5 minutes`, `2 hours`, or an expression resolving to the same format.
- `wait_until`: accepts a valid timestamp literal or expression.

The runner validates the graph is acyclic, persists one `StepExecution` per workflow step, records the selected branch in `outputJson.nextStepKey`, and marks unselected branch steps as `SKIPPED` with `branch_not_selected`.

Intentional waits use the existing durable resume path: the step is stored as `RETRYING` with `nextRetryAt`, the execution lease is released, BullMQ receives a delayed job, and the reconciler can recover missed delayed jobs. When the wait is due, the runner completes the existing wait step instead of recalculating it.

Postponed capabilities remain out of scope: loops, foreach, parallel execution, explicit join nodes, subworkflows, cron, JavaScript, plugins, branch-local variables, collaborative editing, AI-generated workflows, partial node execution, interactive debugging, and human approval waits.
