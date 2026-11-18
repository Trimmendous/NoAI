import { practiceCommand } from './job-guide-command.js';
// A local teaching fixture: no IPC, filesystem operations, or provider calls.
const steps = [
  ['1 of 3 · Review a sample job', 'First review · Codex · read-only · one time', 'Prompt: Summarize this project. Project: /sample/project. In a real job, confirm the folder and permissions before creating it.', 'Show sample result'],
  ['2 of 3 · Inspect the sample result', 'First review · Succeeded (sample)', 'A completed job keeps its run history. Open the job and select the occurrence you want to inspect, then choose Open conversation.', 'Open sample conversation'],
  ['3 of 3 · Read the sample conversation', 'Assistant · Sample response', 'This example project contains a README, source files and tests. No files were changed. This is built-in teaching text, not an agent result. Real conversations show only saved messages; missing usage stays unavailable.', 'Finish practice'],
];
const root = document.querySelector('#job-guide');
if (root) {
  const fields = Object.fromEntries(['title', 'prompt', 'project'].map(key => [key, root.querySelector(`#job-guide-${key}`)]));
  function updateCommand() {
    const status = root.querySelector('#job-guide-validation');
    const copy = root.querySelector('#job-guide-copy');
    root.querySelector('#job-guide-copy-status').textContent = '';
    try {
      root.querySelector('pre code').textContent = practiceCommand(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])));
      status.textContent = '';
      copy.disabled = false;
    } catch (error) {
      status.textContent = error.message;
      root.querySelector('pre code').textContent = 'Complete the practice fields to preview a command.';
      copy.disabled = true;
    }
  }
  Object.values(fields).forEach(field => field.addEventListener('input', updateCommand));
  updateCommand();
  const start = root.querySelector('#job-practice-start');
  const panel = root.querySelector('#job-practice');
  const heading = root.querySelector('#job-practice-heading');
  const next = root.querySelector('#job-practice-next');
  const back = root.querySelector('#job-practice-back');
  let step = 0;
  function render() {
    const [title, summary, body, action] = steps[step];
    heading.textContent = title;
    root.querySelector('#job-practice-summary').textContent = summary;
    root.querySelector('#job-practice-body').textContent = body;
    next.textContent = action;
    back.disabled = step === 0;
    heading.focus();
  }
  function close() { panel.hidden = true; start.textContent = 'Replay sample walkthrough'; start.focus(); }
  start.addEventListener('click', () => { step = 0; panel.hidden = false; render(); });
  next.addEventListener('click', () => { if (step === steps.length - 1) close(); else { step++; render(); } });
  back.addEventListener('click', () => { if (step > 0) { step--; render(); } });
  root.querySelector('#job-practice-skip').addEventListener('click', close);
  root.querySelector('#job-guide-copy').addEventListener('click', async () => {
    const status = root.querySelector('#job-guide-copy-status');
    try {
      await navigator.clipboard.writeText(root.querySelector('pre code').textContent);
      status.textContent = 'Copied safe CLI command.';
    } catch {
      status.textContent = 'Clipboard unavailable. Select and copy the command above.';
    }
  });
}
