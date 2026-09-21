import { expect, it } from "vitest";
import {
  checkRepo,
  diffInvariantIds,
  specInvariantIds,
  testInvariantIds,
} from "../../scripts/check-invariants.js";
import { repoRoot } from "../helpers/repo-root.js";

it("S-7: ID в таблице спеки без теста — расхождение", () => {
  const spec = specInvariantIds("| INV-08 | формулировка |\n| INV-99 | нет теста |\n");
  const tests = testInvariantIds(['it("INV-08: повтор не создаёт событие", () => {});']);
  expect(diffInvariantIds(spec, tests)).toEqual({
    missing: ["INV-99"],
    extra: [],
  });
});

it("S-7: тест с ID вне спеки — расхождение", () => {
  const spec = specInvariantIds("| INV-08 | формулировка |\n");
  const tests = testInvariantIds([
    'it("INV-08: повтор не создаёт событие", () => {});',
    'it("INV-99: лишний", () => {});',
  ]);
  expect(diffInvariantIds(spec, tests)).toEqual({
    missing: [],
    extra: ["INV-99"],
  });
});

it("S-7: it.todo с префиксом INV-xx считается именем теста", () => {
  const spec = specInvariantIds("| INV-03 | переходы |\n");
  const tests = testInvariantIds([
    'it.todo("INV-03: переходы только по таблице переходов");',
  ]);
  expect(diffInvariantIds(spec, tests)).toEqual({ missing: [], extra: [] });
});

it("S-7: спека репозитория покрыта именами тестов", () => {
  const { specIds, missing, extra } = checkRepo(repoRoot);
  expect(specIds.length).toBeGreaterThan(0);
  expect(missing).toEqual([]);
  expect(extra).toEqual([]);
});
