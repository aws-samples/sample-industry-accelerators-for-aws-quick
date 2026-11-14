# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Code execution, background jobs and file access inside the sandbox.

On AgentCore Runtime every session runs in its own microVM, so this module manages the state of exactly one sandbox:
the files under the working directory and the jobs started in it. Each `execute_code` call is a fresh process (no
interpreter state is kept between calls); state persists only as files.

Code runs as the same non-root user as the server, with a minimal environment (no AWS or server variables) and the
sandbox environment's own Python interpreter, which cannot import the server's packages. Everything the caller
controls is bounded: code size, run time, returned output, file reads and writes, directory listings and the number of
jobs.
"""

import asyncio
import base64
import binascii
import os
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

WORKDIR = Path(os.environ.get("SANDBOX_WORKDIR", "/workspace"))
HOME = Path(os.environ.get("SANDBOX_HOME", str(WORKDIR)))
# Job output spools. Unless configured, a new private directory (mode 0700, unpredictable name) in the system temp
# directory, so no other process can pre-create or replace it.
STATE_DIR = Path(os.environ.get("SANDBOX_STATE_DIR") or tempfile.mkdtemp(prefix="code-sandbox-"))
PYTHON = os.environ.get("SANDBOX_PYTHON", "/opt/sandbox/bin/python")

MAX_CODE_CHARS = 256 * 1024
DEFAULT_TIMEOUT_S = 300
MAX_TIMEOUT_S = 600
DEFAULT_OUTPUT_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 256 * 1024
DEFAULT_READ_BYTES = 256 * 1024
MAX_READ_BYTES = 1024 * 1024
MAX_WRITE_CHARS = 1024 * 1024
MAX_PATH_CHARS = 4096
MAX_LIST_ENTRIES = 5000
MAX_RUNNING_JOBS = 8
# Completed jobs (and their spooled output) beyond this count are removed, oldest first.
MAX_RETAINED_JOBS = 256
LABEL_CHARS = 120

Language = Literal["python", "bash"]
Encoding = Literal["text", "base64"]


class SandboxError(Exception):
    """A failure reported to the caller with a fixed code and a message that holds no caller-controlled content."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def invalid(message: str) -> SandboxError:
    return SandboxError("INVALID_INPUT", message)


# ---------------------------------------------------------------------------------------------------------------------
# Paths and arguments


def resolve_path(path: str | None, default: Path | None = None) -> Path:
    """Absolute path for a caller-supplied path; relative paths resolve against the working directory.

    The sandbox is the caller's own microVM and its code can read any file the sandbox user can, so paths are not
    confined to the working directory; they are only checked for size and NUL bytes.
    """
    if path is None or path == "":
        if default is None:
            raise invalid("path is required")
        return default
    if len(path) > MAX_PATH_CHARS or "\x00" in path:
        raise invalid(f"path must be at most {MAX_PATH_CHARS} characters without NUL bytes")
    p = Path(path)
    return p if p.is_absolute() else WORKDIR / p


def bounded(value: int, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise invalid(f"{name} must be an integer from {low} through {high}")
    return value


def child_env() -> dict[str, str]:
    """Environment for sandboxed processes: nothing inherited from the server (no AWS or server variables)."""
    venv = Path(PYTHON).parent.parent
    return {
        "PATH": f"{venv / 'bin'}:/usr/local/bin:/usr/bin:/bin",
        "VIRTUAL_ENV": str(venv),
        "HOME": str(HOME),
        "PWD": str(WORKDIR),
        "TMPDIR": tempfile.gettempdir(),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "MPLBACKEND": "Agg",
    }


# ---------------------------------------------------------------------------------------------------------------------
# Jobs


def _tail(path: Path, max_bytes: int) -> tuple[str, bool]:
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return "", False
    with open(path, "rb") as fh:
        if size > max_bytes:
            fh.seek(size - max_bytes)
        data = fh.read(max_bytes)
    return data.decode("utf-8", errors="replace"), size > max_bytes


@dataclass
class Job:
    """A process whose stdout and stderr are spooled to files under STATE_DIR."""

    id: str
    language: Language
    label: str
    dir: Path
    proc: subprocess.Popen[bytes]
    started: float = field(default_factory=time.monotonic)
    ended: float | None = None
    timed_out: bool = False
    cancelled: bool = False

    @property
    def running(self) -> bool:
        return self.proc.poll() is None

    @property
    def status(self) -> str:
        if self.running:
            return "running"
        if self.timed_out:
            return "timed_out"
        if self.cancelled:
            return "cancelled"
        return "succeeded" if self.proc.returncode == 0 else "failed"

    def kill(self) -> None:
        if self.running:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.proc.wait()
        self.mark_ended()

    def mark_ended(self) -> None:
        if self.ended is None and not self.running:
            self.ended = time.monotonic()

    def describe(self, max_output_bytes: int) -> dict[str, Any]:
        self.mark_ended()
        stdout, stdout_truncated = _tail(self.dir / "stdout", max_output_bytes)
        stderr, stderr_truncated = _tail(self.dir / "stderr", max_output_bytes)
        return {
            "job_id": self.id,
            "language": self.language,
            "status": self.status,
            "exit_code": None if self.running else self.proc.returncode,
            "duration_seconds": round((self.ended or time.monotonic()) - self.started, 3),
            "stdout": stdout,
            "stderr": stderr,
            "stdout_truncated": stdout_truncated,
            "stderr_truncated": stderr_truncated,
        }

    def summary(self) -> dict[str, Any]:
        self.mark_ended()
        return {
            "job_id": self.id,
            "language": self.language,
            "label": self.label,
            "status": self.status,
            "exit_code": None if self.running else self.proc.returncode,
            "duration_seconds": round((self.ended or time.monotonic()) - self.started, 3),
        }


class Sandbox:
    """Jobs and files of the sandbox. One instance per server process, which serves one runtime session."""

    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self._busy = False
        self._status_changed = int(time.time())

    # -- lifecycle -----------------------------------------------------------------------------------------------------

    def running_jobs(self) -> int:
        return sum(1 for job in self.jobs.values() if job.running)

    def ping_status(self) -> dict[str, Any]:
        """AgentCore Runtime `/ping` payload: HealthyBusy while any job runs, so the session is not stopped as idle.

        `time_of_last_update` changes only when the status does; a value that advanced on every ping would stop the
        idle timeout from ever firing.
        """
        busy = self.running_jobs() > 0
        if busy != self._busy:
            self._busy = busy
            self._status_changed = int(time.time())
        return {"status": "HealthyBusy" if busy else "Healthy", "time_of_last_update": self._status_changed}

    def _reap(self) -> None:
        finished = sorted((j for j in self.jobs.values() if not j.running), key=lambda j: j.started)
        for job in finished[: max(0, len(self.jobs) - MAX_RETAINED_JOBS)]:
            del self.jobs[job.id]
            shutil.rmtree(job.dir, ignore_errors=True)

    def _start(self, code: str, language: Language, cwd: Path) -> Job:
        if self.running_jobs() >= MAX_RUNNING_JOBS:
            raise SandboxError(
                "TOO_MANY_JOBS",
                f"{MAX_RUNNING_JOBS} jobs are already running; wait for one or cancel it with cancel_job",
            )
        if not cwd.is_dir():
            raise invalid("cwd is not an existing directory")
        job_id = secrets.token_hex(6)
        job_dir = STATE_DIR / "jobs" / job_id
        job_dir.mkdir(parents=True)
        script = job_dir / ("main.py" if language == "python" else "main.sh")
        script.write_text(code, encoding="utf-8")
        interpreter = [PYTHON] if language == "python" else ["/bin/bash"]
        first_line = next((line.strip() for line in code.splitlines() if line.strip()), "")
        with open(job_dir / "stdout", "wb") as out, open(job_dir / "stderr", "wb") as err:
            # `nice` keeps the server responsive to tool calls and pings while code saturates the CPUs. Each job gets
            # its own process group so a timeout or cancel_job kills its children too.
            proc = subprocess.Popen(
                ["nice", "-n", "10", *interpreter, str(script)],
                cwd=cwd,
                env=child_env(),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                process_group=0,
            )
        job = Job(id=job_id, language=language, label=first_line[:LABEL_CHARS], dir=job_dir, proc=proc)
        self.jobs[job_id] = job
        self._reap()
        return job

    @staticmethod
    async def _wait(job: Job, timeout_s: float) -> bool:
        """Waits up to `timeout_s` for the job to finish without blocking the event loop. True when it finished."""
        deadline = time.monotonic() + timeout_s
        delay = 0.02
        while job.running:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            await asyncio.sleep(min(delay, remaining))
            delay = min(delay * 2, 0.5)
        job.mark_ended()
        return True

    # -- tools ---------------------------------------------------------------------------------------------------------

    async def execute(
        self,
        code: str,
        language: Language = "python",
        cwd: str | None = None,
        timeout_seconds: int = DEFAULT_TIMEOUT_S,
        background: bool = False,
        max_output_bytes: int = DEFAULT_OUTPUT_BYTES,
    ) -> dict[str, Any]:
        if not isinstance(code, str) or not code.strip():
            raise invalid("code must be a non-empty string")
        if len(code) > MAX_CODE_CHARS:
            raise invalid(f"code must be at most {MAX_CODE_CHARS} characters")
        if language not in ("python", "bash"):
            raise invalid("language must be python or bash")
        timeout_seconds = bounded(timeout_seconds, "timeout_seconds", 1, MAX_TIMEOUT_S)
        max_output_bytes = bounded(max_output_bytes, "max_output_bytes", 1, MAX_OUTPUT_BYTES)
        job = self._start(code, language, resolve_path(cwd, WORKDIR))
        if background:
            return {"job_id": job.id, "status": job.status, "hint": "Poll with get_job; stop it with cancel_job."}
        if not await self._wait(job, timeout_seconds):
            job.timed_out = True
            job.kill()
        return job.describe(max_output_bytes)

    def _job(self, job_id: str) -> Job:
        job = self.jobs.get(job_id) if isinstance(job_id, str) else None
        if job is None:
            raise SandboxError("JOB_NOT_FOUND", "No job with that job_id exists in this sandbox")
        return job

    async def get_job(
        self, job_id: str | None = None, wait_seconds: int = 0, max_output_bytes: int = DEFAULT_OUTPUT_BYTES
    ) -> dict[str, Any]:
        wait_seconds = bounded(wait_seconds, "wait_seconds", 0, MAX_TIMEOUT_S)
        max_output_bytes = bounded(max_output_bytes, "max_output_bytes", 1, MAX_OUTPUT_BYTES)
        if not job_id:
            jobs = sorted(self.jobs.values(), key=lambda j: j.started)
            return {"jobs": [j.summary() for j in jobs], "running": self.running_jobs()}
        job = self._job(job_id)
        if wait_seconds:
            await self._wait(job, wait_seconds)
        return job.describe(max_output_bytes)

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        job = self._job(job_id)
        if job.running:
            job.cancelled = True
            job.kill()
        return job.describe(4096)

    def read_file(
        self, path: str, encoding: Encoding = "text", offset: int = 0, max_bytes: int = DEFAULT_READ_BYTES
    ) -> dict[str, Any]:
        target = resolve_path(path)
        offset = bounded(offset, "offset", 0, 2**62)
        max_bytes = bounded(max_bytes, "max_bytes", 1, MAX_READ_BYTES)
        if encoding not in ("text", "base64"):
            raise invalid("encoding must be text or base64")
        if not target.is_file():
            raise SandboxError("FILE_NOT_FOUND", "No regular file exists at that path")
        try:
            size = target.stat().st_size
            with open(target, "rb") as fh:
                fh.seek(offset)
                data = fh.read(max_bytes)
        except PermissionError:
            raise SandboxError("PERMISSION_DENIED", "The sandbox user cannot read that file") from None
        if encoding == "base64":
            content = base64.b64encode(data).decode("ascii")
        else:
            try:
                content = data.decode("utf-8")
            except UnicodeDecodeError:
                raise SandboxError("NOT_TEXT", "The data is not valid UTF-8; retry with encoding=base64") from None
        return {
            "path": str(target),
            "size": size,
            "offset": offset,
            "bytes_read": len(data),
            "truncated": offset + len(data) < size,
            "encoding": encoding,
            "content": content,
        }

    def write_file(
        self, path: str, content: str, encoding: Encoding = "text", append: bool = False, executable: bool = False
    ) -> dict[str, Any]:
        target = resolve_path(path)
        if not isinstance(content, str):
            raise invalid("content must be a string")
        if len(content) > MAX_WRITE_CHARS:
            raise invalid(f"content must be at most {MAX_WRITE_CHARS} characters")
        if encoding == "base64":
            try:
                data = base64.b64decode(content, validate=True)
            except (binascii.Error, ValueError):
                raise invalid("content is not valid base64") from None
        elif encoding == "text":
            data = content.encode("utf-8")
        else:
            raise invalid("encoding must be text or base64")
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "ab" if append else "wb") as fh:
                fh.write(data)
            if executable:
                target.chmod(0o755)
            size = target.stat().st_size
        except IsADirectoryError:
            raise invalid("path is a directory") from None
        except PermissionError:
            raise SandboxError("PERMISSION_DENIED", "The sandbox user cannot write that path") from None
        return {"path": str(target), "bytes_written": len(data), "size": size}

    def list_files(self, path: str | None = None, recursive: bool = False) -> dict[str, Any]:
        root = resolve_path(path, WORKDIR)
        if not root.is_dir():
            raise SandboxError("FILE_NOT_FOUND", "No directory exists at that path")
        entries: list[dict[str, Any]] = []
        truncated = False
        try:
            iterator = root.rglob("*") if recursive else root.iterdir()
            for p in iterator:
                if len(entries) >= MAX_LIST_ENTRIES:
                    truncated = True
                    break
                try:
                    st = p.lstat()
                except OSError:
                    continue
                kind = "symlink" if p.is_symlink() else "dir" if p.is_dir() else "file"
                entries.append({"path": str(p.relative_to(root)), "type": kind, "size": st.st_size})
        except PermissionError:
            raise SandboxError("PERMISSION_DENIED", "The sandbox user cannot list that directory") from None
        entries.sort(key=lambda e: e["path"])
        return {"path": str(root), "entries": entries, "truncated": truncated}
