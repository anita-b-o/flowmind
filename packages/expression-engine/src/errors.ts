import type { ExpressionValidationIssue } from "./types";

export const EXPRESSION_ERROR_CODES = {
  syntaxInvalid: "EXPRESSION_SYNTAX_INVALID",
  namespaceUnknown: "EXPRESSION_NAMESPACE_UNKNOWN",
  segmentForbidden: "EXPRESSION_SEGMENT_FORBIDDEN",
  stepUnknown: "EXPRESSION_STEP_UNKNOWN",
  stepNotAvailable: "EXPRESSION_STEP_NOT_AVAILABLE",
  pathNotFound: "EXPRESSION_PATH_NOT_FOUND",
  typeMismatch: "EXPRESSION_TYPE_MISMATCH",
  accessDenied: "EXPRESSION_ACCESS_DENIED"
} as const;

export class ExpressionError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly expression?: string;
  readonly namespace?: string;

  constructor(issue: ExpressionValidationIssue) {
    super(issue.message);
    this.name = "ExpressionError";
    this.code = issue.code;
    this.path = issue.path;
    this.expression = issue.expression;
    this.namespace = issue.namespace;
  }

  toJSON(): ExpressionValidationIssue {
    return {
      code: this.code,
      message: this.message,
      path: this.path,
      expression: this.expression,
      namespace: this.namespace
    };
  }
}
