# Changes

When a job is set to **work on a separate copy**, each run works on its own git branch (named like `noai/fix-login-1122-a1b2`) in a separate folder. Your working copy is never touched, and two jobs on the same project can't collide.

When the run finishes, whatever it changed is saved on that branch and appears here.

## Reviewing

Open a change to see what it did, file by file: green lines were added, red lines removed.

- **Merge**: brings the changes into the branch you had checked out. Your folder must have no uncommitted changes; if the changes would conflict, nothing is merged and Noai tells you.
- **Open pull request**: pushes the branch and opens a pull request (using GitHub's `gh` tool if installed, otherwise your host's page).
- **Discard**: throws the changes away (tap twice to confirm).

## Good to know

- Only works for folders that are **git repositories** with at least one commit. Otherwise the job works directly in the folder, and its run says so.
- A run that changed nothing is cleaned up straight away and doesn't appear here.
