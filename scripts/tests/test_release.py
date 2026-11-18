from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from pl_vendor.release import ReleaseOptions, build_release


REPOSITORY = Path(__file__).resolve().parents[2]


def run_git(repository: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def test_release_configuration_builds_root_level_element(tmp_path: Path):
    repository = tmp_path / "release-repository"
    element_destination = repository / "elements" / "pl-media-player"
    element_destination.parent.mkdir(parents=True)
    shutil.copytree(
        REPOSITORY / "elements" / "pl-media-player",
        element_destination,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    for file_name in ("LICENSE", "README.md", "release.toml"):
        shutil.copy2(REPOSITORY / file_name, repository / file_name)

    run_git(repository, "init", "-b", "main")
    run_git(repository, "add", ".")
    run_git(
        repository,
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=release-test@example.invalid",
        "commit",
        "-m",
        "Test release inputs",
    )

    result = build_release(repository, ReleaseOptions(dry_run=True))
    released_files = run_git(repository, "ls-tree", "-r", "--name-only", result.tree)

    assert result.source_branch == "main"
    assert result.target_branch == "release"
    assert result.status == "created"
    assert result.dry_run
    assert released_files.splitlines() == [
        "LICENSE",
        "README.md",
        "info.json",
        "pl-media-player.css",
        "pl-media-player.js",
        "pl-media-player.mustache",
        "pl-media-player.py",
        "schema.json",
        "schemas/pl-media-player.json",
        "test_pl_media_player.py",
    ]
