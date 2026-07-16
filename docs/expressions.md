# Variables and Expressions

Flowmind supports a limited expression language for reusing data between steps without JavaScript, eval, scripting, plugins, or arbitrary functions.

## Syntax

Expressions use `{{path.to.value}}`.

Examples:

```text
{{trigger.body.email}}
{{steps.classify.output.category}}
{{workflow.variables.region}}
{{execution.id}}
```

When a field is exactly one expression, the resolved value keeps its JSON type. When a field mixes text and expressions, the result is a string.

## Namespaces

- `trigger.body.*`: incoming webhook JSON body.
- `trigger.headers.*`: sanitized webhook headers.
- `workflow.id`, `workflow.versionId`, `workflow.name`, `workflow.variables.*`.
- `steps.<stepKey>.output.*` and `steps.<stepKey>.status` for previous steps only.
- `execution.id`, `execution.correlationId`, `execution.retryOfExecutionId`, `execution.startedAt`.
- `organization.id`, `organization.slug`, `organization.variables.*`.
- `connection.id`, `connection.name`, `connection.type` only.
- `metadata.*` remains a legacy compatibility alias and should not be used for new workflow designs.

## Safety

Expressions cannot use functions, operators, brackets, quotes, JavaScript, `eval`, `constructor`, `prototype`, or `__proto__`. The resolver reads only own properties from plain JSON objects and arrays.

Connection plaintext, API keys, SMTP passwords, tokens, cookies, encrypted secrets, queue internals, worker internals, and sensitive metadata are never exposed through expression scope or the variable catalog.

## Compatibility

Workflow versions without `expressionMode` run in `legacy` mode: missing paths resolve to an empty string. New Builder-created versions use `strict` mode and are validated before persistence.

For `workflowDefinitionSchemaVersion: 2`, step availability is derived from graph predecessors rather than only array position. Delay durations and Wait Until timestamps may come from expressions, but must resolve to positive supported durations or valid timestamps at runtime.
