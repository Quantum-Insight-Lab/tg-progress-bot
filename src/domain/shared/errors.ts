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
  CHAT_ID_BLANK: 'chat_id_blank',
  CHAT_TIMEZONE_BLANK: 'chat_timezone_blank',
  CHAT_NOT_SUPERGROUP: 'chat_not_supergroup',
  CHAT_IS_TOPIC: 'chat_is_topic',
  CHAT_ADMIN_RIGHTS: 'chat_admin_rights',
  CHAT_BIND_ACTOR: 'chat_bind_actor',
  CHAT_PROJECT_MISSING: 'chat_project_missing',
  CHAT_ALREADY_BOUND: 'chat_already_bound',
  CHAT_DUPLICATE: 'chat_duplicate',
  CHAT_IDEMPOTENCY_KEY: 'chat_idempotency_key',
  PROJECT_MEMBER_ID_BLANK: 'project_member_id_blank',
  PROJECT_MEMBER_PROJECT_BLANK: 'project_member_project_blank',
  PROJECT_MEMBER_USER_BLANK: 'project_member_user_blank',
  PROJECT_ROLE: 'project_role',
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
