// Runs in the background while the plugin is on: commands and events.
noai.onCommand('say-hello', () => noai.notify('Hello from the example plugin 👋'));

noai.onCommand('count-messages', async ({ chatId }) => {
  if (!chatId) return noai.notify('Open a chat first.');
  const chat = await noai.chats.get(chatId);
  return noai.notify(`“${chat.title}” has ${chat.messages.length} messages.`);
});

noai.on('job.finished', job => {
  if (job.status === 'failed') noai.notify(`Job “${job.title}” failed.`, 'error');
});
