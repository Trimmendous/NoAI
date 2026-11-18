// Quote for POSIX shells, including apostrophes and literal shell substitutions.
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export function practiceCommand({title, prompt, project}) {
  if (!title.trim() || !prompt.trim()) throw new Error('Enter a practice title and prompt.');
  if ([title, prompt, project].some(value => /[\x00-\x1f\x7f]/.test(value))) throw new Error('Use single-line text without control characters for this shell example.');
  if ([title, prompt, project].some(value => value.startsWith('--'))) throw new Error('Practice values cannot start with -- (the CLI treats that as an option).');
  return `./bin/noai jobs create --title ${quote(title)} --prompt ${quote(prompt)}${project.trim() ? ` --project ${quote(project)}` : ''} --permissions read-only --dry-run true --format text`;
}
