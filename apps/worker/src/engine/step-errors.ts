export class HttpStepError extends Error {
  constructor(
    readonly status: number,
    message = `HTTP request failed with ${status}`
  ) {
    super(message);
    this.name = "HttpStepError";
  }
}

export class AmbiguousStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousStepError";
  }
}

export class NonRetryableStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableStepError";
  }
}
