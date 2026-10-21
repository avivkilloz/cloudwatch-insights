"""A private working clone of the store repo, driven through the `git` CLI
(PLATFORM_PLAN.md §21.5, D80).

The clone is a cache, never the truth: every use fetches the branch and
resets onto it, so whatever the remote holds wins and a clone left behind by
a crash is harmless. It is shallow (`--depth 1`): what the store judges
conflicts by is the blob of each file, which needs no history.

Secrets never touch a URL or an argument. A token reaches git through
`GIT_ASKPASS` (a script that prints it from this process's environment for
the one command), an SSH key through `GIT_SSH_COMMAND` naming a 0600 file
that is removed when the command ends. Both are registered with `masking`,
and git's own words pass through `mask()` before anyone sees them. Only
https and ssh are allowed -- the server fetches what an admin typed -- unless
`STORE_GIT_ALLOW_FILE_URLS` is set, which pytest and the browser suites do
for a bare repo on disk.
"""

from __future__ import annotations

import contextlib
import dataclasses
import hashlib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Iterator, Optional
from urllib.parse import urlparse

from . import masking

TIMEOUT_SECONDS = 60
_SCP_LIKE = re.compile(r"^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/].*$")


class GitError(RuntimeError):
    """Git failed; the message is masked and readable."""


class Rejected(GitError):
    """The push was refused because the remote moved on: fetch and replay."""


@dataclasses.dataclass(frozen=True)
class Auth:
    """How to reach the repo. `password` is a token (HTTPS), `ssh_key` an
    unencrypted private key in OpenSSH or PEM form; at most one is set."""

    username: str = ""
    password: str = ""
    ssh_key: str = ""
    known_hosts: str = ""

    def __repr__(self) -> str:  # never the secrets, whatever logs it
        kind = "token" if self.password else "ssh key" if self.ssh_key else "none"
        return f"Auth({kind})"


def file_urls_allowed() -> bool:
    return (os.environ.get("STORE_GIT_ALLOW_FILE_URLS") or "").lower() in ("1", "true", "yes")


def check_url(url: str) -> str:
    """The URL as git will use it, or a ValueError a person can act on."""
    url = (url or "").strip()
    if not url:
        raise ValueError("The store needs a repo URL.")
    if _SCP_LIKE.match(url):
        return url
    parsed = urlparse(url)
    if parsed.scheme == "file" and file_urls_allowed():
        return url
    if parsed.scheme not in ("https", "ssh") or not parsed.hostname:
        raise ValueError("The repo URL must be https://… or ssh://… (or git@host:path).")
    if parsed.password or (parsed.scheme == "https" and parsed.username):
        raise ValueError("Don't put credentials in the repo URL: choose the token or key separately.")
    return url


class Repo:
    """One clone, for one (url, branch). Not thread-safe: the store holds an
    advisory lock while it uses one."""

    def __init__(self, url: str, branch: str, workdir: Path, auth: Auth):
        self.url = check_url(url)
        self.branch = branch or "main"
        self.dir = workdir
        self.auth = auth
        masking.register([auth.password, auth.ssh_key])

    # ------------------------------------------------------------- running git

    @contextlib.contextmanager
    def _env(self) -> Iterator[dict[str, str]]:
        allowed = ["https", "ssh"] + (["file"] if file_urls_allowed() else [])
        config = {
            "protocol.allow": "never",
            **{f"protocol.{p}.allow": "always" for p in allowed},
            # No helper of the machine's may answer for us, nor a hook run.
            "credential.helper": "",
            "core.hooksPath": os.devnull,
            "commit.gpgsign": "false",
            # A link in the repo is checked out as a plain file holding its
            # target: whoever can push there must not be able to make this
            # process read or write a file of the server's through it.
            "core.symlinks": "false",
            "advice.detachedHead": "false",
        }
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.dir.parent),
            "LANG": "C",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_COUNT": str(len(config)),
        }
        for i, (k, v) in enumerate(config.items()):
            env[f"GIT_CONFIG_KEY_{i}"] = k
            env[f"GIT_CONFIG_VALUE_{i}"] = v
        with tempfile.TemporaryDirectory(prefix="store-auth-") as tmp:
            if self.auth.password:
                askpass = Path(tmp) / "askpass.sh"
                askpass.write_text(
                    '#!/bin/sh\ncase "$1" in Username*) printf "%s" "$STORE_GIT_USERNAME";; '
                    '*) printf "%s" "$STORE_GIT_PASSWORD";; esac\n'
                )
                askpass.chmod(0o700)
                env["GIT_ASKPASS"] = str(askpass)
                env["STORE_GIT_USERNAME"] = self.auth.username or "x-access-token"
                env["STORE_GIT_PASSWORD"] = self.auth.password
            if self.auth.ssh_key:
                key = Path(tmp) / "key"
                key.write_text(self.auth.ssh_key.strip() + "\n")
                key.chmod(0o600)
                known = Path(tmp) / "known_hosts"
                known.write_text(self.auth.known_hosts or "")
                # Without known hosts given, the first key seen is trusted and
                # kept for the command (the clone is re-made on every start).
                strict = "yes" if self.auth.known_hosts.strip() else "accept-new"
                env["GIT_SSH_COMMAND"] = (
                    f"ssh -i {key} -o IdentitiesOnly=yes -o BatchMode=yes "
                    f"-o UserKnownHostsFile={known} -o StrictHostKeyChecking={strict}"
                )
            yield env

    def git(self, *args: str, check: bool = True, extra_env: Optional[dict[str, str]] = None) -> str:
        with self._env() as env:
            env.update(extra_env or {})
            try:
                proc = subprocess.run(
                    ["git", *args], cwd=self.dir, env=env, capture_output=True, text=True, timeout=TIMEOUT_SECONDS
                )
            except subprocess.TimeoutExpired:
                raise GitError(f"git {args[0]} took longer than {TIMEOUT_SECONDS} s: is the repo reachable?") from None
        if check and proc.returncode != 0:
            message = masking.mask((proc.stderr or proc.stdout or "").strip())
            lines = [ln for ln in message.splitlines() if ln.strip() and not ln.startswith("hint:")]
            text = " ".join(lines[-3:]) or f"git {args[0]} failed"
            if args[0] == "push" and re.search(r"\[rejected\]|non-fast-forward|fetch first", message):
                raise Rejected(text)
            raise GitError(text)
        return proc.stdout

    # ------------------------------------------------------------- the clone

    def sync(self) -> bool:
        """Makes the clone exactly the remote branch. False when the remote
        has no such branch yet (a new repo): the clone is then an empty branch
        that the first commit will create."""
        if not (self.dir / ".git").is_dir() or self._remote() != self.url:
            shutil.rmtree(self.dir, ignore_errors=True)
            self.dir.mkdir(parents=True, exist_ok=True)
            self.git("init", "--quiet")
            self.git("remote", "add", "origin", self.url)
        exists = bool(self.git("ls-remote", "--heads", "origin", self.branch).strip())
        if not exists:
            self.git("checkout", "--quiet", "--orphan", f"store-{os.getpid()}")
            self.git("rm", "-r", "--quiet", "--cached", "--ignore-unmatch", ".")
            self.git("clean", "-fdq")
            return False
        self.git("fetch", "--quiet", "--depth", "1", "origin", f"+refs/heads/{self.branch}:refs/remotes/origin/{self.branch}")
        self.git("checkout", "--quiet", "-B", f"store-{os.getpid()}", f"origin/{self.branch}")
        self.git("reset", "--quiet", "--hard", f"origin/{self.branch}")
        self.git("clean", "-fdq")
        return True

    def _remote(self) -> str:
        try:
            return self.git("remote", "get-url", "origin").strip()
        except GitError:
            return ""

    def blob(self, path: str) -> Optional[str]:
        """The blob of a file as committed at HEAD, None if it isn't there."""
        try:
            out = self.git("ls-tree", "HEAD", "--", path, check=False)
        except GitError:
            return None
        parts = out.split()
        return parts[2] if len(parts) >= 3 and parts[1] == "blob" else None

    def tree(self, path: str) -> Optional[str]:
        """The tree of a folder as committed at HEAD -- what changes when any
        file in it does (D140) -- None if it isn't there."""
        try:
            out = self.git("ls-tree", "HEAD", "--", path, check=False)
        except GitError:
            return None
        parts = out.split()
        return parts[2] if len(parts) >= 3 and parts[1] == "tree" else None

    def hash(self, content: str) -> str:
        """The blob `content` would be, without writing anything."""
        with self._env() as env:
            proc = subprocess.run(
                ["git", "hash-object", "--stdin"], cwd=self.dir, env=env, input=content, capture_output=True,
                text=True, timeout=TIMEOUT_SECONDS,
            )
        return proc.stdout.strip()

    def _inside(self, path: str) -> Path:
        """`path` in the clone, refused if it leads anywhere else -- the other
        half of `core.symlinks=false`, for a clone made before it."""
        target = self.dir / path
        root = os.path.realpath(self.dir)
        if target.is_symlink() or not os.path.realpath(target).startswith(root + os.sep):
            raise GitError(f"{path} isn't a plain file in the repo.")
        return target

    def read(self, path: str) -> Optional[str]:
        target = self._inside(path)
        return target.read_text() if target.is_file() else None

    def write(self, path: str, content: Optional[str]) -> None:
        target = self._inside(path)
        if content is None:
            if target.exists():
                target.unlink()
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def folders(self, directory: str) -> list[str]:
        """The folders directly in `directory` (an item each, D140)."""
        base = self.dir / directory
        if not base.is_dir() or base.is_symlink():
            return []
        return sorted(str(p.relative_to(self.dir)) for p in base.iterdir() if p.is_dir() and not p.is_symlink())

    def read_folder(self, path: str) -> dict[str, str]:
        """A folder's files, by name (its own, not its subfolders')."""
        base = self._inside(path)
        if not base.is_dir():
            return {}
        return {p.name: p.read_text() for p in sorted(base.iterdir()) if p.is_file() and not p.is_symlink()}

    def write_folder(self, path: str, files: Optional[dict[str, str]]) -> None:
        """A folder holding exactly `files` -- what isn't there any more
        removed -- or, None, no folder."""
        base = self._inside(path)
        if base.is_dir():
            for p in base.iterdir():
                if p.is_file() or p.is_symlink():
                    if files is None or p.name not in files:
                        p.unlink()
        if files is None:
            if base.is_dir() and not any(base.iterdir()):
                base.rmdir()
            return
        for name, text in files.items():
            if "/" in name or "\\" in name or name.startswith("."):
                raise GitError(f"{name} isn't a file name a folder can hold.")
            self.write(f"{path}/{name}", text)

    def files(self, directory: str) -> list[str]:
        base = self.dir / directory
        if not base.is_dir() or base.is_symlink():
            return []
        return sorted(
            str(p.relative_to(self.dir)) for p in base.iterdir() if p.is_file() and not p.is_symlink() and p.suffix == ".yaml"
        )

    def commit(self, message: str, author_name: str, author_email: str, committer: tuple[str, str]) -> bool:
        """Commits everything changed; False when nothing was."""
        self.git("add", "-A")
        if not self.git("status", "--porcelain").strip():
            return False
        self.git(
            "commit", "--quiet", "-m", message,
            extra_env={
                "GIT_AUTHOR_NAME": author_name, "GIT_AUTHOR_EMAIL": author_email,
                "GIT_COMMITTER_NAME": committer[0], "GIT_COMMITTER_EMAIL": committer[1],
            },
        )
        return True

    def push(self) -> None:
        self.git("push", "--quiet", "origin", f"HEAD:refs/heads/{self.branch}")


def blob_hash(content: str) -> str:
    """What `git hash-object` says of `content`, worked out here."""
    data = content.encode()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def tree_hash(files: dict[str, str]) -> str:
    """The git tree a folder of exactly `files` is (D140) -- plain files,
    mode 100644, as `write_folder` leaves them -- worked out here, so a
    folder's version can be compared without writing it."""
    entries = b"".join(
        b"100644 " + name.encode() + b"\0" + bytes.fromhex(blob_hash(files[name]))
        for name in sorted(files, key=lambda n: n.encode())
    )
    return hashlib.sha1(b"tree %d\0" % len(entries) + entries).hexdigest()
