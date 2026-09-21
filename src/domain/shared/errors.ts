/** Причины из docs/pda/08: rejected_commands. */
export const DOMAIN_ERROR_CODES = [
  "role_denied",
  "not_a_member",
  "invalid_transition",
  "list_full",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
