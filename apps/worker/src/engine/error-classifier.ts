import { Injectable } from "@nestjs/common";
import { AmbiguousStepError, HttpStepError, NonRetryableStepError } from "./step-errors";

export type ErrorClassification = "retryable" | "non_retryable" | "ambiguous";

@Injectable()
export class ErrorClassifier {
  classify(error: unknown): ErrorClassification {
    if (error instanceof AmbiguousStepError) {
      return "ambiguous";
    }
    if (error instanceof NonRetryableStepError) {
      return "non_retryable";
    }
    if (error instanceof HttpStepError) {
      if ([429, 502, 503, 504].includes(error.status)) {
        return "retryable";
      }
      if ([400, 401, 403].includes(error.status)) {
        return "non_retryable";
      }
      return "ambiguous";
    }

    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (
      message.includes("timed out") ||
      message.includes("timeout") ||
      message.includes("rate limit") ||
      message.includes("temporar") ||
      message.includes("econn") ||
      message.includes("connection") ||
      message.includes("socket") ||
      message.includes("network")
    ) {
      return "retryable";
    }
    if (
      message.includes("config") ||
      message.includes("expression") ||
      message.includes("private, reserved or metadata ip") ||
      message.includes("internal host") ||
      message.includes("method") ||
      message.includes("ssrf") ||
      message.includes("schema")
    ) {
      return "non_retryable";
    }
    return "ambiguous";
  }
}
