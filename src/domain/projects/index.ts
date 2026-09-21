/** Контекст projects. Не импортирует tasks (S-2). */

export type {
  Project,
  ProjectMember,
  Role,
  User,
} from "./types.js";
export { ROLES } from "./types.js";
export {
  addMember,
  removeMember,
  requireMember,
  type MemberAddedEvent,
  type MemberRemovedEvent,
} from "./membership.js";
export {
  registerGuardedHandler,
  registeredHandlers,
  resetHandlerRegistry,
  type MemberDirectory,
  type ProjectAccess,
  type ProjectHandler,
  type RegisteredHandler,
} from "./guard.js";
