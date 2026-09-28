/** Код причины, по которой домен отклонил команду. */
export const DOMAIN_ERROR = {
  USERS_ALREADY_EXIST: 'users_already_exist',
  BLANK_NAME: 'blank_name',
  TELEGRAM_USER_ID: 'telegram_user_id',
  REGISTRATION_DUPLICATE: 'registration_duplicate',
} as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR)[keyof typeof DOMAIN_ERROR];

/** Ошибка домена с кодом причины. Сообщение — для журнала, решение принимает код. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
