/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "S-1-domain-not-telegram",
      comment: "S-1: domain не импортирует telegram",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/telegram" },
    },
    {
      name: "S-1-domain-not-github",
      comment: "S-1: domain не импортирует github",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/github" },
    },
    {
      name: "S-1-domain-not-projections",
      comment: "S-1: domain не импортирует projections",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/projections" },
    },
    {
      name: "S-1-telegram-not-github",
      comment: "слои telegram и github не импортируют друг друга",
      severity: "error",
      from: { path: "^src/telegram" },
      to: { path: "^src/github" },
    },
    {
      name: "S-1-github-not-telegram",
      comment: "слои telegram и github не импортируют друг друга",
      severity: "error",
      from: { path: "^src/github" },
      to: { path: "^src/telegram" },
    },
    {
      name: "S-1-projections-not-domain",
      comment: "проекции не обращаются к домену",
      severity: "error",
      from: { path: "^src/projections" },
      to: { path: "^src/domain" },
    },
    {
      name: "S-2-projects-not-tasks",
      comment: "S-2: projects не импортирует tasks",
      severity: "error",
      from: { path: "^src/domain/projects" },
      to: { path: "^src/domain/tasks" },
    },
    {
      name: "S-2-tasks-not-projects",
      comment: "S-2: tasks не импортирует projects",
      severity: "error",
      from: { path: "^src/domain/tasks" },
      to: { path: "^src/domain/projects" },
    },
    {
      name: "S-2-github-not-projects",
      comment: "S-2: github-контекст не импортирует projects",
      severity: "error",
      from: { path: "^src/domain/github" },
      to: { path: "^src/domain/projects" },
    },
    {
      name: "S-2-github-not-tasks",
      comment: "S-2: github-контекст не импортирует tasks",
      severity: "error",
      from: { path: "^src/domain/github" },
      to: { path: "^src/domain/tasks" },
    },
    {
      name: "config-no-src",
      comment: "src/config ничего не импортирует из src",
      severity: "error",
      from: { path: "^src/config" },
      to: { path: "^src/", pathNot: "^src/config" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".mjs"],
    },
  },
};
