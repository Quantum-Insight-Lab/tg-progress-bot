import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cruise,
  type IConfiguration,
  type ICruiseResult,
  type IFlattenedRuleSet,
} from "dependency-cruiser";
import { repoRoot } from "./repo-root.js";

export async function loadDcConfig(): Promise<IConfiguration> {
  const url = pathToFileURL(join(repoRoot, "dependency-cruiser.config.mjs")).href;
  const mod = (await import(url)) as { default: IConfiguration };
  return mod.default;
}

export function asCruiseResult(output: ICruiseResult | string): ICruiseResult {
  if (typeof output === "string") {
    throw new Error("depcruise вернул строку вместо объекта");
  }
  return output;
}

function ruleSetOf(config: IConfiguration): IFlattenedRuleSet {
  if (config.forbidden === undefined) {
    throw new Error("dependency-cruiser: нет forbidden-правил");
  }
  return { forbidden: config.forbidden };
}

export async function cruiseWithConfig(
  baseDir: string,
  config: IConfiguration,
): Promise<ICruiseResult> {
  const { output } = await cruise(
    ["src"],
    {
      ...config.options,
      ruleSet: ruleSetOf(config),
      validate: true,
      tsPreCompilationDeps: true,
      baseDir,
    },
  );
  return asCruiseResult(output);
}
