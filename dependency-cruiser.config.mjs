// Инварианты сборки S-1, S-2, S-5, S-6 (docs/pda/09-structural-invariants.md), слои — docs/pda/07-architecture.md.
const layer = (name, comment, from, to, pathNot) => ({
  name,
  comment,
  severity: 'error',
  from: { path: from },
  to: pathNot === undefined ? { path: to } : { path: to, pathNot },
});

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    layer('S-1-domain', 'S-1: домен не импортирует адаптеры, проекции и инфраструктуру', '^src/domain/', '^src/(telegram|github|projections|infrastructure)/'),
    layer('S-1-events', 'S-1: журнал событий не знает о домене и адаптерах', '^src/events/', '^src/(domain|telegram|github|projections|infrastructure)/'),
    layer('S-1-config', 'S-1: src/config ничего не импортирует из src', '^src/config/', '^src/', '^src/config/'),
    layer('S-1-telegram-github', 'S-1: адаптеры Telegram и GitHub не импортируют друг друга', '^src/telegram/', '^src/github/'),
    layer('S-1-github-telegram', 'S-1: адаптеры Telegram и GitHub не импортируют друг друга', '^src/github/', '^src/telegram/'),
    layer('S-1-projections', 'S-1: проекции не обращаются к домену и адаптерам', '^src/projections/', '^src/(domain|telegram|github)/'),
    layer(
      'S-2-contexts',
      'S-2: контексты домена связаны только событиями',
      '^src/domain/([^/]+)/',
      '^src/domain/[^/]+/',
      ['^src/domain/$1/', '^src/domain/shared/'],
    ),
    layer('S-5-projections-journal', 'S-5: проекции читают типы событий, но не публикуют и не пишут журнал', '^src/projections/', '^src/events/', '^src/events/generated/'),
    { name: 'S-6-no-circular', comment: 'S-6: циклов между модулями нет', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.mjs'] },
  },
};
