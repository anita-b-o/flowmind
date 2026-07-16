export class LeaseLostError extends Error {
  constructor(message = "Execution lease was lost") {
    super(message);
    this.name = "LeaseLostError";
  }
}
