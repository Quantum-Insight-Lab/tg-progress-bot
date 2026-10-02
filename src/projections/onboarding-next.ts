/** P-20. Образец следующего сообщения. Протокол шага тот же: человек видит, что прислать. */

/** Четыре строки «Новый проект»: имени ещё нет, поэтому в образце метки. */
export function newProjectSample(): string {
  return ['Новый проект', '<имя>', '<описание>', '<час>'].join('\n');
}

/** Ответ корню на первый `/start`: он руководитель, и вот чем завести проект. */
export function rootStartReply(leadSentence: string): string {
  return `${leadSentence}\n\n${newProjectSample()}`;
}

/** Две строки, которыми открывают состав. Имя — этого проекта. */
export function participantsSample(projectName: string): string {
  return ['Участники', projectName].join('\n');
}

/** Рассылка включена — тем же ответом показано, как открыть состав. */
export function withParticipantsStep(text: string, projectName: string): string {
  return `${text}\n\n${participantsSample(projectName)}`;
}

/** Две строки, которыми открывают топик исполнителя. */
export function executorTopicSample(projectName: string): string {
  return ['Топик исполнителя', projectName].join('\n');
}

/** Участник добавлен — тем же ответом показано, как указать его топик. */
export function withExecutorTopicStep(text: string, projectName: string): string {
  return `${text}\n\n${executorTopicSample(projectName)}`;
}
