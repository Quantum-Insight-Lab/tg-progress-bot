import { Octokit } from "@octokit/rest";
import { markGithubRateRemaining } from "../observability/index.js";

let client: Octokit | undefined;

function attachRateHook(instance: Octokit): void {
  instance.hook.after("request", (_options, response) => {
    const remaining = response.headers["x-ratelimit-remaining"];
    if (typeof remaining === "string") {
      const parsed = Number.parseInt(remaining, 10);
      if (Number.isFinite(parsed)) {
        markGithubRateRemaining(parsed);
      }
    }
  });
}

/** Единственный Octokit (S-4, INV-09: только чтение). */
export function githubClient(): Octokit {
  if (client === undefined) {
    client = new Octokit();
    attachRateHook(client);
  }
  return client;
}

/** Только для тестов. */
export function resetGithubClientForTests(): void {
  client = undefined;
}
