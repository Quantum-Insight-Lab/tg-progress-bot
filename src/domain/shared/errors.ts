/** Код причины, по которой домен отклонил команду. */
export const DOMAIN_ERROR = {
  USERS_ALREADY_EXIST: 'users_already_exist',
  BLANK_NAME: 'blank_name',
  TELEGRAM_USER_ID: 'telegram_user_id',
  REGISTRATION_DUPLICATE: 'registration_duplicate',
  PROJECT_ID_BLANK: 'project_id_blank',
  PROJECT_NAME_BLANK: 'project_name_blank',
  PROJECT_TIMEZONE_BLANK: 'project_timezone_blank',
  PROJECT_CREATED_AT_BLANK: 'project_created_at_blank',
  PROJECT_CREATOR: 'project_creator',
  PROJECT_CHAT: 'project_chat',
  PROJECT_DUPLICATE: 'project_duplicate',
  PROJECT_IDEMPOTENCY_KEY: 'project_idempotency_key',
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
