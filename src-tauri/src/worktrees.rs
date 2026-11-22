//! Jobs that work on a separate copy of a git repository. Each run gets its own
//! worktree on a branch named after the job, so jobs never edit your working
//! copy (or each other's files). When the run ends, whatever it changed is
//! committed on that branch and waits in Changes for you to merge, open a pull
//! request for, or discard. Everything goes through the `git` command line,
//! so it behaves the same on macOS, Linux and Windows.
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// Where a run's copy lives and what it changed.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// The repository's main folder.
    pub repo: String,
    /// The worktree folder.
    pub path: String,
    /// Where the agent works: the worktree, plus the job's subfolder of the repo.
    pub workdir: String,
    pub branch: String,
    /// The commit the branch started from.
    pub base: String,
    /// The branch checked out in the main folder when the run started.
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub files: u32,
    #[serde(default)]
    pub insertions: u32,
    #[serde(default)]
    pub deletions: u32,
    /// "running", "pending" (ready to review), "none" (no changes),
    /// "merged", "published" or "discarded".
    pub review: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

fn git_binary() -> PathBuf {
    crate::platform::find_executable("git").unwrap_or_else(|| PathBuf::from("git"))
}

/// Config that makes git run a program of the repo's choosing. Noai's own git
/// calls run outside any agent sandbox, so a hook or fsmonitor an agent left
/// behind (or one a cloned project ships via an install script) would
/// otherwise run with the user's full rights. Hooks are off for everything
/// Noai does on its own; only an explicit publish keeps them (see `publish`).
const NO_REPO_PROGRAMS: [&str; 4] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
];

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_command(dir, &[&NO_REPO_PROGRAMS[..], args].concat())
}

fn git_command(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(git_binary())
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Cannot run git: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(if message.is_empty() {
            format!("git {} failed", args.first().unwrap_or(&""))
        } else {
            message
        })
    }
}

/// The repository containing `project`, if it is inside one.
pub fn repo_root(project: &Path) -> Option<PathBuf> {
    git(project, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(PathBuf::from)
}

/// "noai/fix-the-login-timeout-0812-a1b2": readable, unique per run.
pub fn branch_name(title: &str, run_id: &str, at: u64) -> String {
    let mut slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let stamp = chrono::DateTime::from_timestamp(at as i64, 0)
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%m%d-%H%M")
                .to_string()
        })
        .unwrap_or_default();
    let mut last: Vec<char> = run_id
        .chars()
        .rev()
        .filter(char::is_ascii_alphanumeric)
        .take(4)
        .collect();
    last.reverse();
    let tail: String = last.into_iter().collect();
    format!(
        "noai/{}-{stamp}-{tail}",
        if slug.is_empty() { "job" } else { &slug }
    )
}

/// Makes a fresh worktree for one run, under `under/<run id>`.
pub fn create(
    project: &Path,
    under: &Path,
    title: &str,
    run_id: &str,
    at: u64,
) -> Result<Worktree, String> {
    let root = repo_root(project).ok_or("Not a git repository")?;
    let base = git(&root, &["rev-parse", "HEAD"])
        .map_err(|_| "The repository has no commits yet".to_string())?;
    let target = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let branch = branch_name(title, run_id, at);
    std::fs::create_dir_all(under).map_err(|error| error.to_string())?;
    let path = under.join(
        run_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect::<String>(),
    );
    git(
        &root,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &path.to_string_lossy(),
            &base,
        ],
    )?;
    let inside = project.canonicalize().ok().and_then(|project| {
        root.canonicalize()
            .ok()
            .and_then(|root| project.strip_prefix(root).ok().map(Path::to_path_buf))
    });
    let workdir = inside
        .filter(|relative| !relative.as_os_str().is_empty())
        .map_or_else(|| path.clone(), |relative| path.join(relative));
    Ok(Worktree {
        repo: root.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        workdir: workdir.to_string_lossy().into_owned(),
        branch,
        base,
        target: if target == "HEAD" {
            String::new()
        } else {
            target
        },
        review: "running".into(),
        ..Worktree::default()
    })
}

/// Commits whatever the run left uncommitted, then counts what the branch
/// changed. A run that changed nothing is cleaned up straight away.
pub fn finish(tree: &mut Worktree, message: &str) {
    let path = PathBuf::from(&tree.path);
    if !git(&path, &["status", "--porcelain"])
        .unwrap_or_default()
        .is_empty()
    {
        let _ = git(&path, &["add", "-A"]);
        if git(&path, &["commit", "-q", "--no-verify", "-m", message]).is_err() {
            // No git identity configured: commit as Noai rather than lose the work.
            let _ = git(
                &path,
                &[
                    "-c",
                    "user.name=Noai",
                    "-c",
                    "user.email=noai@localhost",
                    "commit",
                    "-q",
                    "--no-verify",
                    "-m",
                    message,
                ],
            );
        }
    }
    let repo = PathBuf::from(&tree.repo);
    let stat = git(&repo, &["diff", "--shortstat", &tree.base, &tree.branch]).unwrap_or_default();
    let number = |word: &str| {
        stat.split(',')
            .find(|part| part.contains(word))
            .and_then(|part| part.split_whitespace().next()?.parse().ok())
            .unwrap_or(0)
    };
    tree.files = number("file");
    tree.insertions = number("insertion");
    tree.deletions = number("deletion");
    if tree.files == 0 {
        remove(tree);
        tree.review = "none".into();
    } else {
        tree.review = "pending".into();
    }
}

/// The branch's changes as a unified diff (capped, for very large changes).
pub fn diff(tree: &Worktree) -> Result<String, String> {
    let mut text = git(
        Path::new(&tree.repo),
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            &tree.base,
            &tree.branch,
        ],
    )?;
    const LIMIT: usize = 2 * 1024 * 1024;
    if text.len() > LIMIT {
        let cut = (0..=LIMIT)
            .rev()
            .find(|index| text.is_char_boundary(*index))
            .unwrap_or(0);
        text.truncate(cut);
        text.push_str(
            "\n… diff truncated (over 2 MB). Open the branch in your editor to see the rest.\n",
        );
    }
    Ok(text)
}

fn remove(tree: &Worktree) {
    let repo = PathBuf::from(&tree.repo);
    let _ = git(&repo, &["worktree", "remove", "--force", &tree.path]);
    let _ = git(&repo, &["branch", "-D", &tree.branch]);
}

/// Merges the branch into the branch checked out in the main folder.
pub fn merge(tree: &mut Worktree, title: &str) -> Result<(), String> {
    let repo = PathBuf::from(&tree.repo);
    if !git(&repo, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err(
            "Your working copy has uncommitted changes. Commit or stash them, then merge.".into(),
        );
    }
    let current = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !tree.target.is_empty() && current != tree.target {
        return Err(format!(
            "The job started from {}, but {} is checked out now. Switch back to {}, then merge.",
            tree.target, current, tree.target
        ));
    }
    if let Err(error) = git(
        &repo,
        &[
            "merge",
            "--no-ff",
            "--no-edit",
            "-m",
            &format!("Merge Noai job: {title}"),
            &tree.branch,
        ],
    ) {
        let _ = git(&repo, &["merge", "--abort"]);
        return Err(format!("The changes conflict with your branch, so nothing was merged. Merge {} yourself to resolve it. ({error})", tree.branch));
    }
    let _ = git(&repo, &["worktree", "remove", "--force", &tree.path]);
    let _ = git(&repo, &["branch", "-d", &tree.branch]);
    tree.review = "merged".into();
    Ok(())
}

/// Throws the changes away: removes the worktree and its branch.
pub fn discard(tree: &mut Worktree) {
    remove(tree);
    tree.review = "discarded".into();
}

/// Pushes the branch and opens a pull request (with GitHub's `gh` when it's
/// installed, otherwise the host's "compare" page). Returns the page to open.
pub fn publish(tree: &mut Worktree) -> Result<String, String> {
    let repo = PathBuf::from(&tree.repo);
    // The user clicked Publish, so this is their push: keep their pre-push
    // hooks (Git LFS uploads files from one). fsmonitor stays off.
    git_command(
        &repo,
        &[
            "-c",
            "core.fsmonitor=false",
            "push",
            "-u",
            "origin",
            &tree.branch,
        ],
    )
    .map_err(|error| format!("Could not push the branch: {error}"))?;
    let gh = crate::platform::find_executable("gh");
    let url = gh
        .and_then(|gh| {
            let output = Command::new(gh)
                .current_dir(&repo)
                .args(["pr", "create", "--fill", "--head", &tree.branch])
                .stdin(Stdio::null())
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&output.stdout);
            text.lines()
                .rev()
                .find(|line| line.starts_with("https://"))
                .map(str::to_owned)
        })
        .or_else(|| {
            compare_url(
                &git(&repo, &["remote", "get-url", "origin"]).ok()?,
                &tree.branch,
            )
        })
        .ok_or("The branch was pushed. Open a pull request for it on your git host.")?;
    let _ = git(&repo, &["worktree", "remove", "--force", &tree.path]);
    tree.review = "published".into();
    tree.url = Some(url.clone());
    Ok(url)
}

/// GitHub / GitLab-style "compare" page for a remote URL (https or ssh).
pub fn compare_url(remote: &str, branch: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches(".git");
    let web = if let Some(rest) = remote.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        format!("https://{host}/{path}")
    } else if remote.starts_with("https://") {
        remote
            .split_once('@')
            .map_or_else(|| remote.to_owned(), |(_, rest)| format!("https://{rest}"))
    } else {
        return None;
    };
    Some(if web.contains("gitlab") {
        format!("{web}/-/merge_requests/new?merge_request[source_branch]={branch}")
    } else {
        format!("{web}/compare/{branch}?expand=1")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap()
                .status
                .success(),
            "git {args:?}"
        );
    }

    #[test]
    fn branch_names_and_compare_links() {
        let name = branch_name("Fix the login timeout!", "scheduled-run-1-abcd", 0);
        assert!(
            name.starts_with("noai/fix-the-login-timeout-") && name.ends_with("-abcd"),
            "{name}"
        );
        assert_eq!(
            compare_url("git@github.com:me/app.git", "noai/x").unwrap(),
            "https://github.com/me/app/compare/noai/x?expand=1"
        );
        assert_eq!(
            compare_url("https://token@github.com/me/app", "b").unwrap(),
            "https://github.com/me/app/compare/b?expand=1"
        );
        assert!(compare_url("/local/path", "b").is_none());
    }

    #[test]
    fn a_run_works_on_its_own_branch_and_can_be_merged_or_discarded() {
        let root = std::env::temp_dir().join(format!("noai-worktree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("app")).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.name", "Test"]);
        run(&repo, &["config", "user.email", "test@example.com"]);
        std::fs::write(repo.join("app/readme.txt"), "hello\n").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-q", "-m", "first"]);

        // The job's folder is a subfolder; the agent works in the same subfolder of its copy.
        let mut tree = create(
            &repo.join("app"),
            &root.join("trees"),
            "Edit readme",
            "run-1",
            0,
        )
        .unwrap();
        assert!(tree.workdir.ends_with("app"));
        std::fs::write(
            Path::new(&tree.workdir).join("readme.txt"),
            "hello\nworld\n",
        )
        .unwrap();
        std::fs::write(repo.join("app/readme.txt"), "hello\n").unwrap(); // working copy untouched
        finish(&mut tree, "Noai job: Edit readme");
        assert_eq!(
            (tree.review.as_str(), tree.files, tree.insertions),
            ("pending", 1, 1)
        );
        assert!(diff(&tree).unwrap().contains("+world"));
        merge(&mut tree, "Edit readme").unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.join("app/readme.txt")).unwrap(),
            "hello\nworld\n"
        );
        assert!(!Path::new(&tree.path).exists());

        // No changes: cleaned up at once. Discard removes the branch.
        let mut idle = create(&repo, &root.join("trees"), "Nothing", "run-2", 0).unwrap();
        finish(&mut idle, "Noai job: Nothing");
        assert_eq!(idle.review, "none");
        let mut tossed = create(&repo, &root.join("trees"), "Toss", "run-3", 0).unwrap();
        std::fs::write(Path::new(&tossed.workdir).join("new.txt"), "x").unwrap();
        finish(&mut tossed, "Noai job: Toss");
        discard(&mut tossed);
        assert!(git(&repo, &["rev-parse", "--verify", &tossed.branch]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hook or fsmonitor planted in the repo must never run from Noai's own
    /// git calls (create, auto-commit, merge, discard).
    #[cfg(unix)]
    #[test]
    fn repo_hooks_and_fsmonitor_never_run() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("noai-hooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.name", "Test"]);
        run(&repo, &["config", "user.email", "test@example.com"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-q", "-m", "first"]);

        let marker = root.join("ran");
        let script = root.join("planted.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"$0\" >> '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let hooks = repo.join(".git/hooks");
        for hook in [
            "pre-commit",
            "commit-msg",
            "post-commit",
            "post-checkout",
            "pre-merge-commit",
            "post-merge",
        ] {
            std::fs::copy(&script, hooks.join(hook)).unwrap();
        }
        run(
            &repo,
            &["config", "core.fsmonitor", script.to_str().unwrap()],
        );

        let mut tree = create(&repo, &root.join("trees"), "Hooks", "run-1", 0).unwrap();
        std::fs::write(Path::new(&tree.workdir).join("b.txt"), "b\n").unwrap();
        finish(&mut tree, "Noai job: Hooks");
        assert_eq!(tree.review, "pending");
        merge(&mut tree, "Hooks").unwrap();
        assert!(
            !marker.exists(),
            "planted program ran: {}",
            std::fs::read_to_string(&marker).unwrap_or_default()
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
