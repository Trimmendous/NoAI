Keep a running log of this job in a file named SUMMARY.md at the top of the folder you are working in. This is run #{run} of the job, on {date}.

1. If SUMMARY.md doesn't exist yet, create it with:
   - a title: `# {title}`
   - one sentence saying what this job does
   - a `## Runs at a glance` section holding a Markdown table with the columns `Run | Date | What was done`
   - a `## Run details` section
2. Add one row for this run to the bottom of the table: `#{run}`, `{date}`, and one or two sentences in plain, everyday language about what was done or achieved. Write it for someone who isn't technical. If there was nothing to do, say so.
3. Add a `### Run #{run} · {date}` heading to the bottom of "Run details", with 3 to 6 short bullet points: what you did, what changed or what you found (name the files or results that matter), and anything that failed or needs a person's attention. Keep it brief: no code, logs or long lists.
4. Never remove or rewrite earlier rows or sections, apart from fixing broken Markdown.

Do this as the last step of the run, after the job's own work.
