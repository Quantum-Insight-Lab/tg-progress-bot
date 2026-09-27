/**
 * Публикация backlog в GitHub по схеме docs/backlog/README.md, раздел «Публикация».
 *   npm run backlog:publish             — сухой прогон: план по лейблам, milestones, issues, связям и доске; ничего не пишет
 *   npm run backlog:publish -- --apply  — выполнить план
 *   npm run backlog:publish -- --preview I-24 — тело issue в том виде, в каком оно уйдёт на GitHub
 * Повторный запуск безопасен: issue с `github: N` в front matter заново не создаётся, существующие связи и элементы доски пропускаются.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKLOG_DIR, BACKLOG_INDEX, parseIssue, type Issue } from './tz-check.ts';

export const BRANCH = 'v2-from-spec';
export const ASSIGNEE = 'plyuschevmax';
export const MILESTONE_PREFIX = 'v2 · ';
export const PROJECT_TITLE = 'tg-progress-bot v2';
export const CONTEXT_FIELD = 'Контекст';
export const ATOMS_FIELD = 'Атомов';
const CREATE_PAUSE_MS = 1000;

export const LABELS: Readonly<Record<string, { color: string; description: string }>> = {
  'context:events': { color: '0e6251', description: 'Журнал событий и идемпотентность' },
  'context:infra': { color: '0b6e4f', description: 'Процесс, планировщик, развёртывание, метрики' },
  'context:projects': { color: '148f77', description: 'Люди, проекты, группы, топики, роли и доступ' },
  'context:github': { color: '117a65', description: 'Зеркало GitHub, только чтение' },
  'context:tasks': { color: '1abc9c', description: 'Задачи, канвас, блокеры' },
  'context:progress': { color: '48c9b0', description: 'Доля бэклога, снимки, отчёты' },
  'type:feat': { color: '57606a', description: 'Атомы ТЗ к реализации' },
  'type:chore': { color: '8b949e', description: 'Эксплуатация, метрики, приёмка' },
};

export interface BacklogIssue extends Issue {
  text: string;
}

/** Milestones — строки таблицы «Этапы» в README backlog: название и «Что даёт». */
export function milestonesFromIndex(index: string): { title: string; description: string }[] {
  return [...index.matchAll(/^\| (M\d+ [^|]+?) \| \d+ \| \d+ \| ([^|]+?) \|$/gm)].map((m) => ({ title: `${MILESTONE_PREFIX}${m[1] ?? ''}`, description: m[2] ?? '' }));
}

/** Тело issue на GitHub: файл без front matter и заголовка, ссылки на документы репозитория — абсолютные. */
export function issueBody(issue: BacklogIssue, repoUrl: string): string {
  const lines = issue.text.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\s*# .*\n/, '')
    .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path: string) => `](${repoUrl}/blob/${BRANCH}/${posix.normalize(posix.join(BACKLOG_DIR, path))})`)
    .trim();
  return `Источник: [\`${BACKLOG_DIR}/${issue.id}.md\`](${repoUrl}/blob/${BRANCH}/${BACKLOG_DIR}/${issue.id}.md)\n\n${body}\n`;
}

/** Front matter с номером issue на GitHub. */
export function withGithub(text: string, number: number): string {
  if (/^github: \d+$/m.test(text)) return text.replace(/^github: \d+$/m, `github: ${number}`);
  return text.replace(/^(id: I-\d+)$/m, `$1\ngithub: ${number}`);
}

/** Порядок создания: блокирующая issue раньше заблокированной. */
export function creationOrder(issues: Issue[]): Issue[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const done = new Set<string>();
  const order: Issue[] = [];
  const visit = (issue: Issue): void => {
    if (done.has(issue.id)) return;
    done.add(issue.id);
    for (const ref of issue.blockedBy) {
      const blocker = byId.get(ref);
      if (blocker) visit(blocker);
    }
    order.push(issue);
  };
  [...issues].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })).forEach(visit);
  return order;
}

function gh(args: string[], input?: string): string {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

function ghJson<T>(args: string[], input?: string): T {
  return JSON.parse(gh(args, input)) as T;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readBacklogIssues(): BacklogIssue[] {
  return readdirSync(BACKLOG_DIR)
    .filter((name) => /^I-\d{2,}.*\.md$/.test(name))
    .map((name) => {
      const file = join(BACKLOG_DIR, name);
      const text = readFileSync(file, 'utf8');
      const { issue, findings } = parseIssue({ file, text });
      if (!issue) throw new Error(findings.map((f) => f.message).join('\n'));
      return { ...issue, text };
    });
}

async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const repo = ghJson<{ nameWithOwner: string; url: string; owner: { login: string } }>(['repo', 'view', '--json', 'nameWithOwner,url,owner']);
  const owner = repo.owner.login;
  const issues = readBacklogIssues();
  const preview = argv[argv.indexOf('--preview') + 1];
  if (argv.includes('--preview')) {
    const issue = issues.find((i) => i.id === preview);
    console.log(issue ? `${issue.title}\n${issue.milestone ?? ''} · ${issue.labels.join(', ')} · ${ASSIGNEE} · blocked by ${issue.blockedBy.join(', ') || '—'}\n\n${issueBody(issue, repo.url)}` : `${preview ?? '?'}: такой issue нет`);
    return issue ? 0 : 1;
  }
  const log = (line: string): void => console.log(`${apply ? '' : '[план] '}${line}`);
  console.log(`${repo.nameWithOwner} · ${apply ? 'публикация' : 'сухой прогон, ничего не пишется'} · issues ${issues.length}`);

  const labels = ghJson<{ name: string; color: string; description: string }[]>(['label', 'list', '--limit', '200', '--json', 'name,color,description']);
  for (const [name, want] of Object.entries(LABELS)) {
    const have = labels.find((label) => label.name === name);
    if (have && have.color.toLowerCase() === want.color && have.description === want.description) continue;
    const changes = have
      ? [have.description === want.description ? '' : `описание «${have.description}» → «${want.description}»`, have.color.toLowerCase() === want.color ? '' : `цвет ${have.color} → ${want.color}`]
      : [`создать, цвет ${want.color}, «${want.description}»`];
    log(`лейбл ${name}: ${changes.filter(Boolean).join(', ')}`);
    if (apply) gh(['label', 'create', name, '--color', want.color, '--description', want.description, '--force']);
  }

  const milestones = ghJson<{ number: number; title: string }[]>(['api', `repos/${repo.nameWithOwner}/milestones?state=all&per_page=100`]);
  const milestoneNumber = new Map(milestones.map((m) => [m.title, m.number]));
  for (const { title, description } of milestonesFromIndex(readFileSync(join(BACKLOG_DIR, BACKLOG_INDEX), 'utf8'))) {
    if (milestoneNumber.has(title)) continue;
    log(`milestone «${title}»: создать`);
    if (apply) milestoneNumber.set(title, ghJson<{ number: number }>(['api', '-X', 'POST', `repos/${repo.nameWithOwner}/milestones`, '--input', '-'], JSON.stringify({ title, description })).number);
  }

  const node = new Map<string, { number: number; id: number; url: string }>();
  let created = 0;
  for (const issue of creationOrder(issues) as BacklogIssue[]) {
    if (issue.github !== undefined) {
      if (apply) {
        const found = ghJson<{ number: number; id: number; html_url: string }>(['api', `repos/${repo.nameWithOwner}/issues/${issue.github}`]);
        node.set(issue.id, { number: found.number, id: found.id, url: found.html_url });
      }
      continue;
    }
    const milestone = `${MILESTONE_PREFIX}${issue.milestone ?? ''}`;
    created += 1;
    if (!apply) continue;
    const milestoneId = milestoneNumber.get(milestone);
    if (milestoneId === undefined) throw new Error(`${issue.id}: milestone «${milestone}» не найден — есть ли он в таблице «Этапы»?`);
    const payload = { title: issue.title, body: issueBody(issue, repo.url), labels: issue.labels, assignees: [ASSIGNEE], milestone: milestoneId };
    const made = ghJson<{ number: number; id: number; html_url: string }>(['api', '-X', 'POST', `repos/${repo.nameWithOwner}/issues`, '--input', '-'], JSON.stringify(payload));
    node.set(issue.id, { number: made.number, id: made.id, url: made.html_url });
    writeFileSync(issue.file, withGithub(issue.text, made.number));
    console.log(`${issue.id} → #${made.number} ${issue.title}`);
    await pause(CREATE_PAUSE_MS);
  }
  log(`issues: создать ${created}, уже на GitHub ${issues.length - created}; assignee ${ASSIGNEE}`);

  let links = 0;
  for (const issue of issues) {
    const target = node.get(issue.id);
    const existing = apply && target ? ghJson<{ number: number }[]>(['api', `repos/${repo.nameWithOwner}/issues/${target.number}/dependencies/blocked_by`]).map((i) => i.number) : [];
    for (const ref of issue.blockedBy) {
      const blocker = node.get(ref);
      if (blocker && existing.includes(blocker.number)) continue;
      links += 1;
      if (apply && target && blocker) {
        gh(['api', '-X', 'POST', `repos/${repo.nameWithOwner}/issues/${target.number}/dependencies/blocked_by`, '--input', '-'], JSON.stringify({ issue_id: blocker.id }));
        await pause(CREATE_PAUSE_MS / 4);
      }
    }
  }
  log(`связи «blocked by»: добавить ${links}`);

  let project: { number: number; url: string } | undefined;
  try {
    project = ghJson<{ projects: { number: number; title: string; url: string }[] }>(['project', 'list', '--owner', owner, '--format', 'json']).projects.find((p) => p.title === PROJECT_TITLE);
  } catch {
    log(`доска: список проектов не читается — нужен scope project (gh auth refresh -s project)`);
    return apply ? 1 : 0;
  }
  if (!project) {
    log(`доска «${PROJECT_TITLE}»: создать, связать с ${repo.nameWithOwner}, поля «${CONTEXT_FIELD}» и «${ATOMS_FIELD}»`);
    if (!apply) {
      log(`доска: добавить ${issues.length} issues; представления — вручную: таблица по Milestone, доска по полю «${CONTEXT_FIELD}»`);
      return 0;
    }
    project = ghJson<{ number: number; url: string }>(['project', 'create', '--owner', owner, '--title', PROJECT_TITLE, '--format', 'json']);
    gh(['project', 'link', String(project.number), '--owner', owner, '--repo', repo.nameWithOwner]);
    const contexts = [...new Set(issues.flatMap((issue) => issue.labels.filter((l) => l.startsWith('context:')).map((l) => l.slice('context:'.length))))];
    gh(['project', 'field-create', String(project.number), '--owner', owner, '--name', CONTEXT_FIELD, '--data-type', 'SINGLE_SELECT', '--single-select-options', contexts.join(',')]);
    gh(['project', 'field-create', String(project.number), '--owner', owner, '--name', ATOMS_FIELD, '--data-type', 'NUMBER']);
  }
  const items = apply ? ghJson<{ items: { content?: { url?: string } }[] }>(['project', 'item-list', String(project.number), '--owner', owner, '--limit', '500', '--format', 'json']).items : [];
  const onBoard = new Set(items.map((item) => item.content?.url));
  let added = 0;
  for (const issue of issues) {
    const target = node.get(issue.id);
    if (target && onBoard.has(target.url)) continue;
    added += 1;
    if (!apply || !target) continue;
    const context = issue.labels.find((l) => l.startsWith('context:'))?.slice('context:'.length) ?? '';
    const board = [String(project.number), '--owner', owner, '--url', target.url];
    gh(['project', 'item-add', ...board]);
    gh(['project', 'item-edit', ...board, '--field', CONTEXT_FIELD, '--value', context]);
    gh(['project', 'item-edit', ...board, '--field', ATOMS_FIELD, '--number', String(issue.atoms.length)]);
  }
  log(`доска ${project.url}: добавить ${added} issues; представления — вручную: таблица по Milestone, доска по полю «${CONTEXT_FIELD}»`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '';
      console.error(stderr || (error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    },
  );
}
