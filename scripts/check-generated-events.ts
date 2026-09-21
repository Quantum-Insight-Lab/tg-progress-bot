/**
 * S-3: повторная генерация должна совпасть с закоммиченным src/events/generated.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = "src/events/generated";
const nodeArgs = [
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  join(root, "scripts/codegen-events.ts"),
];

execFileSync(process.execPath, nodeArgs, { cwd: root, stdio: "inherit" });

const diff = execFileSync("git", ["diff", "--", generated], {
  cwd: root,
  encoding: "utf8",
});
const untracked = execFileSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "--", generated],
  { cwd: root, encoding: "utf8" },
);

if (diff !== "" || untracked !== "") {
  process.stderr.write(
    "S-3: src/events/generated расходится с contracts/event-registry.yaml. Запустите npm run codegen:events и закоммитьте результат.\n",
  );
  if (diff !== "") process.stderr.write(diff);
  if (untracked !== "") process.stderr.write(`untracked:\n${untracked}`);
  process.exit(1);
}
