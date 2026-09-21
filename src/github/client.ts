import { Octokit } from "@octokit/rest";

let client: Octokit | undefined;

/** Единственный Octokit (S-4, INV-09: только чтение). */
export function githubClient(): Octokit {
  client ??= new Octokit();
  return client;
}

/** Только для тестов. */
export function resetGithubClientForTests(): void {
  client = undefined;
}
