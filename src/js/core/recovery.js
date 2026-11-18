// Merge a durable job snapshot without replaying already rendered output.
// The native journal is authoritative for scheduled runs; newer live events win.
export function recoverJobMessage(message, job) {
  const events = Array.isArray(job.events) ? job.events : [];
  const lastEventId = Math.max(0, ...events.map(event => event.eventId || 0));
  if ((message.lastEventId || 0) > lastEventId) return message;
  const text = events.filter(event => event.type === 'text' && event.text).map(event => event.text).join('\n\n');
  const statuses = { waiting: 'waiting', running: 'streaming', completed: 'complete', cancelled: 'interrupted', needs_attention: 'error' };
  return {
    ...message,
    content: text || message.content,
    status: statuses[job.status] || message.status,
    lastEventId,
    runId: job.runId,
  };
}
