export type DomainErrorCode =
  | "not_found"
  | "already_exists"
  | "revision_conflict"
  | "idempotency_mismatch"
  | "gone"
  | "validation_failed"
  | "secret_detected"
  | "forbidden"
  | "reauthentication_required"
  | "limit_exceeded"
  | "internal_error";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
