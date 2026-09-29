import { describe, expect, it } from 'vitest';
import {
  GITHUB_FACT_CLOSED_ISSUE,
  GITHUB_FACT_COMMIT,
  GITHUB_FACT_PULL_REQUEST,
  GITHUB_FACT_REPOSITORY,
  GITHUB_OWNERSHIP_PERSONAL,
  GITHUB_OWNERSHIP_REPOSITORY,
  ownGithubFacts,
  type GithubFact,
  type OwnershipMember,
  type OwnershipProject,
} from '../src/domain/github/fact-owner.ts';
import { ISSUE_STATE_CLOSED, ISSUE_STATE_OPEN } from '../src/domain/github/issue.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';

const repo = '42';
const otherRepo = '7';
const projectA = '00000000-0000-4000-8000-00000000000a';
const projectB = '00000000-0000-4000-8000-00000000000b';
const projectC = '00000000-0000-4000-8000-00000000000c';
const projectD = '00000000-0000-4000-8000-00000000000d';
const adaId = '00000000-0000-4000-8000-000000000001';
const graceId = '00000000-0000-4000-8000-000000000002';

const projects: OwnershipProject[] = [
  { projectId: projectA, repositoryId: repo },
  { projectId: projectB, repositoryId: repo },
  { projectId: projectC, repositoryId: otherRepo },
  { projectId: projectD, repositoryId: null },
];

function ada(projectId: string, githubLogin: string | null = 'ada'): OwnershipMember {
  return { projectId, userId: adaId, githubLogin };
}

function pullRequest(authorLogin: string, number = 12): GithubFact {
  return {
    ownership: GITHUB_OWNERSHIP_PERSONAL,
    kind: GITHUB_FACT_PULL_REQUEST,
    pullRequest: { repositoryId: repo, pullRequestNumber: number, authorLogin },
  };
}

describe('принадлежность факта GitHub', () => {
  it('INV-13 PR чужого логина не виден ни одному проекту и в блокеры не поднимается', () => {
    const owned = ownGithubFacts([pullRequest('outsider')], projects, [ada(projectA), ada(projectB), ada(projectC)]);
    expect(owned.lines).toEqual([]);
    expect(owned.mirrorAuthors).toEqual([
      { kind: GITHUB_FACT_PULL_REQUEST, repositoryId: repo, key: '12', login: 'outsider' },
    ]);
    expect(owned.lines.some((line) => line.ownership === GITHUB_OWNERSHIP_PERSONAL)).toBe(false);
  });

  it('INV-13 автор в двух проектах виден в обоих, внутри проекта PR один', () => {
    const fact = pullRequest('Ada');
    const owned = ownGithubFacts(
      [fact, fact],
      [...projects, { projectId: projectA, repositoryId: repo }],
      [ada(projectA), ada(projectA, 'ADA'), ada(projectB), { projectId: projectA, userId: graceId, githubLogin: 'grace' }],
    );
    expect(owned.lines).toEqual([
      {
        ownership: GITHUB_OWNERSHIP_PERSONAL,
        kind: GITHUB_FACT_PULL_REQUEST,
        projectId: projectA,
        userId: adaId,
        repositoryId: repo,
        key: '12',
        actorLogin: 'Ada',
      },
      {
        ownership: GITHUB_OWNERSHIP_PERSONAL,
        kind: GITHUB_FACT_PULL_REQUEST,
        projectId: projectB,
        userId: adaId,
        repositoryId: repo,
        key: '12',
        actorLogin: 'Ada',
      },
    ]);
    expect(owned.mirrorAuthors).toEqual([
      { kind: GITHUB_FACT_PULL_REQUEST, repositoryId: repo, key: '12', login: 'Ada' },
    ]);
  });

  it('INV-13 смена логина снимает сопоставление, автор остаётся в зеркале', () => {
    const before = ownGithubFacts([pullRequest('ada')], projects, [ada(projectA)]);
    expect(before.lines.map((line) => line.projectId)).toEqual([projectA]);
    const after = ownGithubFacts([pullRequest('ada')], projects, [ada(projectA, 'grace')]);
    expect(after.lines).toEqual([]);
    expect(after.mirrorAuthors).toEqual([
      { kind: GITHUB_FACT_PULL_REQUEST, repositoryId: repo, key: '12', login: 'ada' },
    ]);
    expect(ownGithubFacts([pullRequest('ada')], projects, [ada(projectA, null)]).lines).toEqual([]);
    expect(ownGithubFacts([pullRequest('ada')], projects, [ada(projectA, '  ')]).lines).toEqual([]);
  });

  it('INV-13 коммит принадлежит автору, закрытый issue — тому, кто закрыл', () => {
    const owned = ownGithubFacts(
      [
        {
          ownership: GITHUB_OWNERSHIP_PERSONAL,
          kind: GITHUB_FACT_COMMIT,
          commit: { repositoryId: repo, sha: 'abc', authorLogin: 'ada' },
        },
        {
          ownership: GITHUB_OWNERSHIP_PERSONAL,
          kind: GITHUB_FACT_CLOSED_ISSUE,
          issue: {
            state: ISSUE_STATE_CLOSED,
            repositoryId: repo,
            issueNumber: 4,
            closedByLogin: 'grace',
          },
        },
        {
          ownership: GITHUB_OWNERSHIP_PERSONAL,
          kind: GITHUB_FACT_CLOSED_ISSUE,
          issue: {
            state: ISSUE_STATE_OPEN,
            repositoryId: repo,
            issueNumber: 5,
            closedByLogin: 'ada',
          },
        },
        {
          ownership: GITHUB_OWNERSHIP_PERSONAL,
          kind: GITHUB_FACT_CLOSED_ISSUE,
          issue: {
            state: ISSUE_STATE_CLOSED,
            repositoryId: repo,
            issueNumber: 6,
            closedByLogin: null,
          },
        },
      ],
      projects,
      [ada(projectA), { projectId: projectA, userId: graceId, githubLogin: 'grace' }],
    );
    expect(owned.lines).toEqual([
      {
        ownership: GITHUB_OWNERSHIP_PERSONAL,
        kind: GITHUB_FACT_COMMIT,
        projectId: projectA,
        userId: adaId,
        repositoryId: repo,
        key: 'abc',
        actorLogin: 'ada',
      },
      {
        ownership: GITHUB_OWNERSHIP_PERSONAL,
        kind: GITHUB_FACT_CLOSED_ISSUE,
        projectId: projectA,
        userId: graceId,
        repositoryId: repo,
        key: '4',
        actorLogin: 'grace',
      },
    ]);
    expect(owned.mirrorAuthors).toEqual([
      { kind: GITHUB_FACT_COMMIT, repositoryId: repo, key: 'abc', login: 'ada' },
      { kind: GITHUB_FACT_CLOSED_ISSUE, repositoryId: repo, key: '4', login: 'grace' },
      { kind: GITHUB_FACT_CLOSED_ISSUE, repositoryId: repo, key: '6', login: null },
    ]);
  });

  it('INV-13 факт виден только проектам, куда подключён репозиторий и где человек участник', () => {
    const owned = ownGithubFacts([pullRequest('ada')], projects, [ada(projectC), ada(projectD)]);
    expect(owned.lines).toEqual([]);
    const onOther = ownGithubFacts(
      [
        {
          ownership: GITHUB_OWNERSHIP_PERSONAL,
          kind: GITHUB_FACT_PULL_REQUEST,
          pullRequest: { repositoryId: otherRepo, pullRequestNumber: 3, authorLogin: 'ada' },
        },
      ],
      projects,
      [ada(projectC)],
    );
    expect(onOther.lines.map((line) => line.projectId)).toEqual([projectC]);
    expect(onOther.lines.map((line) => line.projectId)).not.toContain(projectA);
  });

  it('INV-13 общий факт репозитория виден каждому подключённому проекту без логина', () => {
    const owned = ownGithubFacts(
      [
        { ownership: GITHUB_OWNERSHIP_REPOSITORY, repositoryId: ` ${repo} `, key: 'ci' },
        { ownership: GITHUB_OWNERSHIP_REPOSITORY, repositoryId: repo, key: 'ci' },
      ],
      projects,
      [ada(projectA), { projectId: projectA, userId: graceId, githubLogin: 'grace' }],
    );
    expect(owned.lines).toEqual([
      {
        ownership: GITHUB_OWNERSHIP_REPOSITORY,
        kind: GITHUB_FACT_REPOSITORY,
        projectId: projectA,
        userId: null,
        repositoryId: repo,
        key: 'ci',
        actorLogin: null,
      },
      {
        ownership: GITHUB_OWNERSHIP_REPOSITORY,
        kind: GITHUB_FACT_REPOSITORY,
        projectId: projectB,
        userId: null,
        repositoryId: repo,
        key: 'ci',
        actorLogin: null,
      },
    ]);
    expect(owned.mirrorAuthors).toEqual([]);
    expect(owned.lines.map((line) => line.projectId)).not.toContain(projectC);
    expect(() =>
      ownGithubFacts([{ ownership: GITHUB_OWNERSHIP_REPOSITORY, repositoryId: repo, key: '  ' }], projects, []),
    ).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.GITHUB_FACT_KEY }));
    expect(() =>
      ownGithubFacts([{ ownership: GITHUB_OWNERSHIP_REPOSITORY, repositoryId: repo, key: '  ' }], projects, []),
    ).toThrow(DomainError);
  });
});
