import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "../helpers/repo-root.js";

const writeCalls = [
  "issues.create",
  "issues.update",
  "issues.delete",
  "issues.lock",
  "issues.unlock",
  "issues.addAssignees",
  "issues.removeAssignees",
  "issues.createComment",
  "issues.updateComment",
  "issues.deleteComment",
  "pulls.create",
  "pulls.update",
  "pulls.merge",
  "pulls.requestReviewers",
  "git.createRef",
  "git.updateRef",
  "git.createCommit",
  "git.createTree",
  "repos.merge",
  "checks.create",
  "checks.update",
];

function listTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTs(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

it("INV-09: адаптер GitHub не вызывает write-методы Octokit", () => {
  const githubRoot = join(repoRoot, "src/github");
  const hits: string[] = [];
  for (const file of listTs(githubRoot)) {
    const text = readFileSync(file, "utf8");
    for (const call of writeCalls) {
      if (text.includes(call)) {
        hits.push(`${file}: ${call}`);
      }
    }
  }
  expect(hits).toEqual([]);
});
