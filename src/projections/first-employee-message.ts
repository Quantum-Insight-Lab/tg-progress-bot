/** P-17. Первое сообщение сотруднику: один текст в личку и в его топик. */

export const FIRST_MESSAGE_CANVAS = 'Канвас живёт в этом топике.';

export const FIRST_MESSAGE_TASK = 'Задача заводится командой /task в этом топике, она появляется на канвасе.';

export const FIRST_MESSAGE_CHECK = 'Галочка отправляет задачу руководителю и процент проекта не меняет.';

export const FIRST_MESSAGE_BACKLOG = 'Место в бэклоге — issues, где вы assignee.';

/** Где топик и канвас: человек открывает топик в группе проекта. */
export function firstMessageTopicLine(projectName: string, topicId: number): string {
  return `Откройте топик ${topicId} в группе проекта «${projectName}». ${FIRST_MESSAGE_CANVAS}`;
}

function hasGithubLogin(login: string | null): boolean {
  return login !== null && login.trim().length > 0;
}

/**
 * Один и тот же текст для лички и топика.
 * Строка про место в бэклоге есть только при записанном логине GitHub.
 */
export function renderFirstEmployeeMessage(input: {
  projectName: string;
  topicId: number;
  githubLogin: string | null;
}): string {
  const lines = [
    firstMessageTopicLine(input.projectName, input.topicId),
    FIRST_MESSAGE_TASK,
    FIRST_MESSAGE_CHECK,
  ];
  if (hasGithubLogin(input.githubLogin)) lines.push(FIRST_MESSAGE_BACKLOG);
  return lines.join('\n');
}
