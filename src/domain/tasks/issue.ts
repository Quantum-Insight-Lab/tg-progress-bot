import { DomainError } from "../shared/errors.js";
import type { IssueRef } from "./types.js";

/** INV-01: задача только на issue из зеркала своего проекта. */
export function requireIssuesInMirror(
  issues: readonly IssueRef[],
  projectId: string,
): IssueRef[] {
  const listed = issues.filter((issue) => issue.projectId === projectId);
  if (listed.length === 0) {
    throw new DomainError(
      "invalid_transition",
      "Нужен issue своего проекта",
    );
  }
  return listed;
}

export function pickIssueFromMirror(
  issues: readonly IssueRef[],
  projectId: string,
  issueId: string,
): IssueRef {
  const found = requireIssuesInMirror(issues, projectId).find(
    (issue) => issue.id === issueId,
  );
  if (found === undefined) {
    throw new DomainError(
      "invalid_transition",
      "Нужен issue своего проекта",
    );
  }
  return found;
}
