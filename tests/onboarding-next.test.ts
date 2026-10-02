import { describe, expect, it } from 'vitest';
import {
  executorTopicSample,
  newProjectSample,
  participantsSample,
  rootStartReply,
  withExecutorTopicStep,
  withParticipantsStep,
} from '../src/projections/onboarding-next.ts';
import { EXECUTOR_TOPIC_HEADING } from '../src/telegram/executor-topic.ts';
import { NEW_PROJECT_HEADING } from '../src/telegram/new-project.ts';
import { PARTICIPANTS_HEADING } from '../src/telegram/members.ts';
import { START_REPLY_ROOT } from '../src/telegram/start.ts';

describe('P-20 следующий шаг онбординга', () => {
  it('R-964 первый /start корня содержит образец «Новый проект»', () => {
    const reply = rootStartReply(START_REPLY_ROOT);
    expect(reply.startsWith(START_REPLY_ROOT)).toBe(true);
    expect(newProjectSample().split('\n')).toEqual([NEW_PROJECT_HEADING, '<имя>', '<описание>', '<таймзона>']);
    expect(reply).toContain(newProjectSample());
  });

  it('R-965 включённая рассылка показывает «Участники» и имя проекта', () => {
    const reply = withParticipantsStep('Рассылка включена.', 'Альфа');
    expect(participantsSample('Альфа')).toBe(`${PARTICIPANTS_HEADING}\nАльфа`);
    expect(reply).toContain(participantsSample('Альфа'));
  });

  it('R-966 добавленный участник показывает «Топик исполнителя» и имя проекта', () => {
    const reply = withExecutorTopicStep('Борис добавлен как member.', 'Альфа');
    expect(executorTopicSample('Альфа')).toBe(`${EXECUTOR_TOPIC_HEADING}\nАльфа`);
    expect(reply).toContain('Борис добавлен как member.');
    expect(reply).toContain(executorTopicSample('Альфа'));
  });
});
