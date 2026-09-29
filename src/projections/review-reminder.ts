/** Руководитель, которого напоминание упоминает в топике исполнителя. */
export interface ReviewLeadMention {
  telegramUserId: string;
  name: string;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function mention(lead: ReviewLeadMention): string {
  const name = escapeHtml(lead.name);
  if (!/^[1-9]\d*$/.test(lead.telegramUserId)) return name;
  return `<a href="tg://user?id=${lead.telegramUserId}">${name}</a>`;
}

/** Напоминание о задаче на подтверждении с упоминанием руководителей проекта. */
export function reviewReminderText(taskNumber: number, leads: readonly ReviewLeadMention[]): string {
  const mentions = leads.map((lead) => mention(lead)).join(', ');
  if (mentions.length === 0) return `${String(taskNumber)} на подтверждении`;
  return `${String(taskNumber)} на подтверждении, ${mentions}`;
}
