import { describe, expect, it } from 'vitest';
import {
  FIRST_MESSAGE_BACKLOG,
  FIRST_MESSAGE_CANVAS,
  FIRST_MESSAGE_CHECK,
  FIRST_MESSAGE_TASK,
  renderFirstEmployeeMessage,
} from '../src/projections/first-employee-message.ts';

const withLogin = renderFirstEmployeeMessage({ projectName: 'Альфа', topicId: 42, githubLogin: 'boris' });
const withoutLogin = renderFirstEmployeeMessage({ projectName: 'Альфа', topicId: 42, githubLogin: null });

describe('P-17 первое сообщение сотруднику', () => {
  it('R-574 где его топик и канвас', () => {
    expect(withoutLogin).toContain('Откройте топик 42 в группе проекта «Альфа»');
    expect(withoutLogin).toContain(FIRST_MESSAGE_CANVAS);
  });

  it('R-575 задача заводится командой /task в этом топике, она появляется на канвасе', () => {
    expect(withoutLogin).toContain(FIRST_MESSAGE_TASK);
  });

  it('R-576 галочка отправляет задачу руководителю и процент проекта не меняет', () => {
    expect(withoutLogin).toContain(FIRST_MESSAGE_CHECK);
  });

  it('R-577 место в бэклоге — issues, где он assignee', () => {
    expect(withLogin).toContain(FIRST_MESSAGE_BACKLOG);
  });

  it('R-578 без логина GitHub этой строки нет', () => {
    expect(withoutLogin).not.toContain(FIRST_MESSAGE_BACKLOG);
    expect(withoutLogin).not.toContain('Место в бэклоге');
    const blank = renderFirstEmployeeMessage({ projectName: 'Альфа', topicId: 42, githubLogin: '   ' });
    expect(blank).toBe(withoutLogin);
  });

  it('INV-23 текст не меню задач: личка и топик получают пояснение, не кнопки канваса', () => {
    expect(withLogin).not.toContain('в план');
    expect(withLogin).not.toContain('подтвердить');
    expect(withLogin).not.toContain('отменить');
    expect(withLogin.split('\n')).toEqual([
      'Откройте топик 42 в группе проекта «Альфа». Канвас живёт в этом топике.',
      FIRST_MESSAGE_TASK,
      FIRST_MESSAGE_CHECK,
      FIRST_MESSAGE_BACKLOG,
    ]);
  });
});
