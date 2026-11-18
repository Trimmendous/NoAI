import { element } from './dom.js';
import { getHarness } from '../core/catalog.js';

export function countdown(timestamp, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((timestamp * 1000 - now) / 1000));
  if (!Number.isFinite(seconds)) return 'Time unavailable';
  if (seconds <= 0) return 'Checking availability';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `In ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `In ${hours}h ${minutes % 60}m`;
}

export function renderJobs(container, jobs, cancel) {
  const pending = jobs.filter(job => !['completed', 'cancelled'].includes(job.status));
  document.querySelector('#jobs-section').hidden = pending.length === 0;
  const fragment = document.createDocumentFragment();
  for (const job of pending) {
    const card = element('article', 'resume-card');
    const header = element('div', 'resume-card-header');
    header.append(element('h3', '', getHarness(job.harness)?.label || job.harness));
    const labels = { waiting: 'Waiting for quota', running: 'Resuming', needs_attention: 'Needs attention' };
    header.append(element('span', `resume-status ${job.status === 'running' ? 'is-running' : job.status === 'needs_attention' ? 'is-error' : ''}`, labels[job.status] || job.status));
    card.append(header, element('p', '', job.reason || 'Continuing your saved request.'));
    if (job.retryAt && job.status === 'waiting') {
      const counter = element('p', 'resume-countdown', `${countdown(job.retryAt)} · ${new Date(job.retryAt * 1000).toLocaleString()}`);
      card.append(counter);
    }
    const actions = element('div', 'resume-actions');
    actions.append(element('span', 'source-label', `${job.model || 'Harness default'} · ${job.attempts || 0} resume attempts`));
    const stop = element('button', 'secondary-button', job.status === 'running' ? 'Stop' : 'Cancel');
    stop.type = 'button';
    stop.addEventListener('click', () => cancel(job.id));
    actions.append(stop);
    card.append(actions);
    fragment.append(card);
  }
  container.replaceChildren(fragment);
}
