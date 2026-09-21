import { constants, type Priority } from "../../config/index.js";

export function weightOf(priority: Priority): number {
  return constants.priorityWeights[priority];
}
