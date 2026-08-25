//! Carries gitignored `.env*` files from a repository's primary checkout
//! into worktrees opened by Zed.
//!
//! Git worktrees check out tracked files only, so a freshly created worktree
//! is missing the gitignored secrets (`.env`, `.env.local`, ...) that the
//! project's tooling expects. Each `.env*` file in the primary checkout is
//! linked into the worktree as a symlink, keeping the primary checkout the
//! single source of truth across all branches. A file already present in the
//! worktree wins, and a symlink failure falls back to a copy.

use std::{path::Path, path::PathBuf, sync::Arc};

use anyhow::{Context as _, Result};
use fs::{CopyOptions, Fs};
use futures::StreamExt;

/// Links every `.env*` file from the primary checkout of the repository that
/// owns `worktree_path` into `worktree_path`. Returns the number of files
/// linked or copied; zero when the path is not a git checkout.
///
/// Callers log failures and continue: missing env links should never block a
/// worktree from opening.
pub async fn carry_env_files(fs: Arc<dyn Fs>, worktree_path: PathBuf) -> Result<usize> {
    let Some(primary_dir) = primary_checkout_dir(&fs, &worktree_path).await else {
        return Ok(0);
    };

    let mut carried = 0;
    let mut entries = fs.read_dir(&primary_dir).await?;
    while let Some(entry) = entries.next().await {
        let source = entry?;
        let Some(file_name) = source.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_env_file_name(file_name) || !is_file_like(&fs, &source).await {
            continue;
        }

        let target = worktree_path.join(file_name);
        if fs.metadata(&target).await?.is_some() {
            continue;
        }

        match fs.create_symlink(&target, source.clone()).await {
            Ok(()) => carried += 1,
            Err(error) => {
                log::warn!(
                    "Failed to link {} into {}, copying instead: {error}",
                    source.display(),
                    target.display()
                );
                fs.copy_file(
                    &source,
                    &target,
                    CopyOptions {
                        overwrite: false,
                        ignore_if_exists: true,
                    },
                )
                .await
                .with_context(|| {
                    format!(
                        "failed to copy {} into {}",
                        source.display(),
                        target.display()
                    )
                })?;
                carried += 1;
            }
        }
    }
    Ok(carried)
}

async fn is_file_like(fs: &Arc<dyn Fs>, path: &Path) -> bool {
    matches!(fs.metadata(path).await, Ok(Some(metadata)) if !metadata.is_dir)
}

/// Returns the primary checkout of the repository behind `worktree_path`:
/// the path itself when it is the primary checkout, otherwise the checkout
/// owning its `.git` pointer file. `None` for non-git paths and bare
/// repositories, which have no checkout to source env files from.
async fn primary_checkout_dir(fs: &Arc<dyn Fs>, worktree_path: &Path) -> Option<PathBuf> {
    let dot_git = worktree_path.join(".git");
    let metadata = fs.metadata(&dot_git).await.ok()??;
    if metadata.is_dir && !metadata.is_symlink {
        return Some(worktree_path.to_path_buf());
    }

    // Linked worktrees keep a `.git` file containing
    // `gitdir: <primary>/.git/worktrees/<name>`.
    let contents = fs.load(&dot_git).await.ok()?;
    let mut gitdir = PathBuf::from(contents.strip_prefix("gitdir:")?.trim());
    if gitdir.is_relative() {
        gitdir = worktree_path.join(gitdir);
    }

    let mut dir: &Path = gitdir.as_path();
    while let Some(name) = dir.file_name() {
        if name == ".git" {
            return dir.parent().map(Path::to_path_buf);
        }
        dir = dir.parent()?;
    }
    None
}

fn is_env_file_name(name: &str) -> bool {
    name == ".env" || name.starts_with(".env.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_env_file_name() {
        assert!(is_env_file_name(".env"));
        assert!(is_env_file_name(".env.local"));
        assert!(is_env_file_name(".env.production"));
        assert!(!is_env_file_name(".environment"));
        assert!(!is_env_file_name(".envrc"));
        assert!(!is_env_file_name("env"));
    }
}
