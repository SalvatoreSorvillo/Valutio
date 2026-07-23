"""Prepare a clean public source export of Valutio.

This script keeps the private working folder separate from the public release.
It updates:

  ../Valutio-public/github
      A clean source tree intended for the public GitHub repository.

By default it also runs Scripts/build-deploy.py first, so the deploy folder is
kept current when you prepare a public update. It also mirrors the private
Website-source demo gallery into the deploy assets folder. Use --skip-build
when you only need to refresh the GitHub-ready source tree and website demo
assets without rebuilding the app bundle.
"""

from __future__ import annotations

import argparse
import fnmatch
import shutil
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SOURCE_ROOT = SCRIPT_DIR.parent
PROJECT_ROOT = SOURCE_ROOT.parent
DEFAULT_PUBLIC_ROOT = PROJECT_ROOT / "Valutio-public"
WEBSITE_DEMO = PROJECT_ROOT / "Website-source" / "assets" / "demo"
DEPLOY_DEMO = PROJECT_ROOT / "valutio-deploy" / "assets" / "demo"

SOURCE_EXCLUDES = {
    "__pycache__",
    "node_modules",
    "Valutio-public",
}

EXCLUDE_PATTERNS = (
    "*.pyc",
    "*.pyo",
    "*.log",
    ".DS_Store",
    "Thumbs.db",
    ".env",
    ".env.*",
    "*wallet-backup*.json",
    "*valutio-backup*.json",
    "*.backup.json",
    "update-github-version.txt",
)


def should_skip(path: Path, root: Path, named_excludes: set[str]) -> bool:
    rel = path.relative_to(root)
    if any(part.startswith(".") and part != ".gitignore" for part in rel.parts):
        return True
    if any(part in named_excludes for part in rel.parts):
        return True
    return any(fnmatch.fnmatch(path.name, pattern) for pattern in EXCLUDE_PATTERNS)


def copy_clean_tree(source: Path, target: Path, named_excludes: set[str]) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for item in sorted(source.iterdir(), key=lambda p: p.name.lower()):
        if should_skip(item, source, named_excludes):
            continue
        dest = target / item.name
        if item.is_dir():
            shutil.copytree(
                item,
                dest,
                ignore=lambda directory, names: {
                    name
                    for name in names
                    if should_skip(Path(directory) / name, source, named_excludes)
                },
            )
        else:
            shutil.copy2(item, dest)


def empty_folder_keep_git(folder: Path) -> None:
    if not folder.exists():
        folder.mkdir(parents=True)
        return
    for item in folder.iterdir():
        if item.name == ".git":
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()


def run(command: list[str], cwd: Path) -> None:
    print("Running:", " ".join(command))
    subprocess.run(command, cwd=str(cwd), check=True)


def sync_website_demo() -> None:
    if not WEBSITE_DEMO.is_dir():
        raise SystemExit(f"Website demo folder not found: {WEBSITE_DEMO}")
    DEPLOY_DEMO.parent.mkdir(parents=True, exist_ok=True)
    if DEPLOY_DEMO.exists():
        shutil.rmtree(DEPLOY_DEMO)
    shutil.copytree(WEBSITE_DEMO, DEPLOY_DEMO)
    print("Website demo assets:", WEBSITE_DEMO, "->", DEPLOY_DEMO)


def git_is_dirty(repo: Path) -> bool:
    if not (repo / ".git").exists():
        return False
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(repo),
        check=True,
        text=True,
        capture_output=True,
    )
    return bool(result.stdout.strip())


def git_init(repo: Path) -> None:
    if not (repo / ".git").exists():
        run(["git", "init"], repo)
    run(["git", "branch", "-M", "main"], repo)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update the clean Valutio public source export.")
    parser.add_argument(
        "--public-root",
        type=Path,
        default=DEFAULT_PUBLIC_ROOT,
        help="Folder that will contain github/. Default: ../Valutio-public",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Do not run Scripts/build-deploy.py before copying the public source export.",
    )
    parser.add_argument(
        "--init-git",
        action="store_true",
        help="Initialise ../Valutio-public/github as a fresh git repository if needed.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the GitHub-ready export even if it has uncommitted changes.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    public_root = args.public_root.resolve()
    github_dir = public_root / "github"

    if not args.skip_build:
        run([sys.executable, str(SOURCE_ROOT / "Scripts" / "build-deploy.py")], SOURCE_ROOT)

    sync_website_demo()

    if git_is_dirty(github_dir) and not args.force:
        raise SystemExit(
            "The GitHub-ready export has uncommitted changes. Commit, stash, or rerun with --force."
        )

    public_root.mkdir(parents=True, exist_ok=True)
    empty_folder_keep_git(github_dir)
    copy_clean_tree(SOURCE_ROOT, github_dir, SOURCE_EXCLUDES)

    if args.init_git:
        git_init(github_dir)

    print()
    print("Public GitHub-ready source:", github_dir)
    print()
    print("Next steps:")
    print("  Set-Location", github_dir)
    print("  git status")
    print("  git add .")
    print('  git commit -m "Describe the update"')
    print("  git push")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
