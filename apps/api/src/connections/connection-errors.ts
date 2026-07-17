import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";

export const CONNECTION_ERRORS = {
  notFound: "CONNECTION_NOT_FOUND",
  revoked: "CONNECTION_REVOKED",
  typeMismatch: "CONNECTION_TYPE_MISMATCH",
  decryptionFailed: "CONNECTION_DECRYPTION_FAILED",
  testFailed: "CONNECTION_TEST_FAILED",
  inUse: "CONNECTION_IN_USE",
  invalidConfig: "INVALID_CONNECTION_CONFIG"
} as const;

export function connectionNotFound() {
  return new NotFoundException({ code: CONNECTION_ERRORS.notFound, message: "Connection not found" });
}

export function invalidConnectionConfig(message = "Connection configuration is invalid") {
  return new UnprocessableEntityException({ code: CONNECTION_ERRORS.invalidConfig, message });
}

export function connectionInUse() {
  return new ConflictException({ code: CONNECTION_ERRORS.inUse, message: "Connection is used by an active workflow version" });
}

export function connectionTestFailed(message = "Connection test failed") {
  return new BadRequestException({ code: CONNECTION_ERRORS.testFailed, message });
}

export function insufficientConnectionRole() {
  return new ForbiddenException("Insufficient role");
}
