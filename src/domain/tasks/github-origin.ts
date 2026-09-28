import { EVENT_TYPES, type PayloadByType } from '../../events/index.ts';
import { TASK_SOURCE, TASK_TOPIC_CHAT } from './create-task.ts';
import { milestoneAsTaskStatus } from './github-link.ts';

/**
 * Общее между задачей и зеркалом GitHub — человек и проект.
 * Прямой связи нет: issue не родитель задачи и не каталог, из которого её заводят.
 */
export const SHARED_WITH_GITHUB = ['person', 'project'] as const;

/**
 * Факты зеркала. Поток этих событий задачу не создаёт.
 * Назначение на issue — часть `github.issue_changed`, отдельного факта нет.
 */
export const GITHUB_FACT_TYPES = [
  EVENT_TYPES.GITHUB_ISSUE_CHANGED,
  EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
  EVENT_TYPES.GITHUB_COMMITS_PUSHED,
  EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED,
  EVENT_TYPES.GITHUB_MILESTONE_CHANGED,
  EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED,
  EVENT_TYPES.GITHUB_RECONCILED,
  EVENT_TYPES.REPO_PR_STALLED,
] as const;

export type GithubFactType = (typeof GITHUB_FACT_TYPES)[number];

export type GithubFact = {
  [Type in GithubFactType]: { type: Type; payload: PayloadByType[Type] };
}[GithubFactType];

/** Поля зеркала, которых у задачи нет. */
export const ABSENT_MIRROR_FIELDS = ['issue', 'pull_request', 'commit'] as const;

/**
 * Задачи ведут люди в топике исполнителя.
 * Источник — команда человека, не зеркало GitHub.
 */
export function taskLedByPerson(): { place: typeof TASK_TOPIC_CHAT; source: typeof TASK_SOURCE } {
  return { place: TASK_TOPIC_CHAT, source: TASK_SOURCE };
}

/** Issue, на котором человек стоит assignee, задачей не становится. */
export function assigneeBecomesTask(assignees: readonly string[]): false {
  void assignees;
  return false;
}

function declineIssue(payload: PayloadByType['github.issue_changed']): null {
  if (assigneeBecomesTask(payload.assignees)) return null;
  void payload.title;
  void payload.issue_number;
  return null;
}

function decline(fact: GithubFact): null {
  switch (fact.type) {
    case EVENT_TYPES.GITHUB_ISSUE_CHANGED:
      return declineIssue(fact.payload);
    case EVENT_TYPES.GITHUB_MILESTONE_CHANGED:
      milestoneAsTaskStatus(fact.payload.title);
      return null;
    case EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED:
    case EVENT_TYPES.GITHUB_COMMITS_PUSHED:
    case EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED:
    case EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED:
    case EVENT_TYPES.GITHUB_RECONCILED:
    case EVENT_TYPES.REPO_PR_STALLED:
      return null;
    default: {
      const unreachable: never = fact;
      return unreachable;
    }
  }
}

/** Поток фактов GitHub задач не создаёт. */
export function tasksFromGithub(facts: readonly GithubFact[]): readonly [] {
  for (const fact of facts) decline(fact);
  return [];
}
