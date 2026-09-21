import { requireMember } from "./membership.js";
import type { ProjectMember } from "./types.js";

export type ProjectAccess = {
  projectId: string;
  userId: string;
};

export type MemberDirectory = {
  find: (projectId: string, userId: string) => ProjectMember | undefined;
};

export type ProjectHandler<T extends ProjectAccess, R> = (
  input: T,
  member: ProjectMember,
) => R | Promise<R>;

export type RegisteredHandler = {
  id: string;
  guarded: true;
};

const registry: RegisteredHandler[] = [];

/** Единственный способ зарегистрировать хендлер проекта (INV-12). */
export function registerGuardedHandler<T extends ProjectAccess, R>(
  id: string,
  directory: MemberDirectory,
  handler: ProjectHandler<T, R>,
): (input: T) => Promise<R> {
  const wrapped = async (input: T): Promise<R> => {
    const member = requireMember(directory.find(input.projectId, input.userId));
    return handler(input, member);
  };
  registry.push({ id, guarded: true });
  return wrapped;
}

export function registeredHandlers(): readonly RegisteredHandler[] {
  return registry;
}

/** Только тесты: очистка реестра между кейсами. */
export function resetHandlerRegistry(): void {
  registry.length = 0;
}
