import type { Octokit } from "@octokit/rest";
import { githubClient } from "./client.js";
import { parseGithubFact, type ParsedGithubFact } from "./parse.js";

export type GithubReader = {
  factsFor: (repository: string) => Promise<ParsedGithubFact[]>;
};

function splitRepo(
  repository: string,
): { owner: string; repo: string } | undefined {
  const parts = repository.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || owner === undefined || repo === undefined) {
    return undefined;
  }
  if (owner.length === 0 || repo.length === 0) {
    return undefined;
  }
  return { owner, repo };
}

function asFact(
  eventName: string,
  repository: string,
  payload: Record<string, unknown>,
): ParsedGithubFact | undefined {
  return parseGithubFact(eventName, {
    ...payload,
    repository: { full_name: repository },
  });
}

export function octokitGithubReader(client: Octokit = githubClient()): GithubReader {
  return {
    async factsFor(repository) {
      const parsed = splitRepo(repository);
      if (parsed === undefined) {
        return [];
      }
      const { owner, repo } = parsed;
      const facts: ParsedGithubFact[] = [];

      const issues = await client.paginate(client.rest.issues.listForRepo, {
        owner,
        repo,
        state: "all",
        per_page: 100,
      });
      for (const issue of issues) {
        if (issue.pull_request !== undefined) {
          continue;
        }
        const fact = asFact("issues", repository, { issue });
        if (fact !== undefined) {
          facts.push(fact);
        }
      }

      const pulls = await client.paginate(client.rest.pulls.list, {
        owner,
        repo,
        state: "all",
        per_page: 100,
      });
      for (const pull of pulls) {
        const fact = asFact("pull_request", repository, { pull_request: pull });
        if (fact !== undefined) {
          facts.push(fact);
        }
        if (pull.state !== "open" || pull.head.sha.length === 0) {
          continue;
        }
        const checksUnknown: unknown = await client.paginate(
          client.rest.checks.listForRef,
          {
            owner,
            repo,
            ref: pull.head.sha,
            per_page: 100,
          },
        );
        const runs = Array.isArray(checksUnknown) ? checksUnknown : [];
        for (const run of runs) {
          const factRun = asFact("check_run", repository, {
            check_run: {
              ...(typeof run === "object" && run !== null ? run : {}),
              pull_requests: [{ number: pull.number }],
            },
          });
          if (factRun !== undefined) {
            facts.push(factRun);
          }
        }
      }

      const milestones = await client.paginate(
        client.rest.issues.listMilestones,
        {
          owner,
          repo,
          state: "all",
          per_page: 100,
        },
      );
      for (const milestone of milestones) {
        const fact = asFact("milestone", repository, { milestone });
        if (fact !== undefined) {
          facts.push(fact);
        }
      }

      return facts;
    },
  };
}
