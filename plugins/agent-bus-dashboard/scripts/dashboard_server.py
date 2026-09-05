#!/usr/bin/env python3
"""Unified localhost dashboard for the existing coordinator and AgentBus stores.

THESIS: Agent work is a conversation ledger, not a terminal feed or an analytics dashboard.
OWN-WORLD: Monochrome Light/Dark; parchment, crimson and Cloister Black in EVIL.
STORY: Choose a project, control its live agents, then manage complete conversations across Inbox, Archive, and Trash.
FIRST VIEWPORT: Persistent project navigation opens onto a focused conversation ledger with the selected thread beside it.
FORM: A project register, readable agent roster, and conversation index/detail workspace.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import http.client
import json
import os
import re
import secrets
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import monotonic, sleep
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
DEFAULT_COORDINATOR_DB = Path.home() / ".agent-bus" / "coordinator.db"
DEFAULT_COORDINATOR_CLI = Path.home() / ".agent-bus" / "bin" / "prototype"
DEFAULT_AGENT_BUS_DB = Path.home() / ".agent-bus" / "agentcomms.db"
DEFAULT_AGENT_BUS_CLI = Path.home() / ".agent-bus" / "agent_comms_server.py"
DEFAULT_STATUS_DIR = Path.home() / ".agent-bus" / "status"
DEFAULT_PROJECTS_ROOT = Path.home() / "Projects"
DEFAULT_LIVE_BUS_URL = "http://127.0.0.1:7717"
DEFAULT_OPERATOR_TOKEN = Path.home() / ".agent-bus" / "operator.token"
DEFAULT_AUDIT_LOG = Path.home() / ".agent-bus" / "bus.jsonl"
DEFAULT_DASHBOARD_STATE = Path.home() / ".agent-bus" / "dashboard-state.json"
DEFAULT_AGENT_BUS_ROOT = Path.home() / ".agent-bus"
PROJECT_MARKERS = {
    ".git",
    "Cargo.toml",
    "Package.swift",
    "go.mod",
    "package.json",
    "project.godot",
    "pyproject.toml",
}
LIVE_SNAPSHOT_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
LIVE_LAST_GOOD_SNAPSHOT: dict[str, dict[str, Any]] = {}
AUDIT_MESSAGE_CACHE: dict[str, tuple[int, int, list[dict[str, Any]]]] = {}
LIVE_SNAPSHOT_TTL_SECONDS = 0.25
CONVERSATIONS_PER_PAGE = 40
MAX_ROLE_LENGTH = 80
MAX_SESSION_LENGTH = 128
SESSION_ID_RE = re.compile(
    r"(?:"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    r"|[0-9a-fA-F]{32}"
    r"|session_[A-Za-z0-9_-]{8,80}"
    r")"
)
SESSION_ID_PREFIXES = (
    "codex://threads/",
    "claude://sessions/",
    "thread:",
    "session:",
)
ROLE_PRESETS = (
    "Commander",
    "Integrator",
    "Science Research",
    "Legal & Ethics",
    "Systems Research",
    "Frontend",
    "Product Design",
    "Independent QA",
    "Researcher",
    "Worker",
)
REGISTRY_LOCK = threading.RLock()


class RoleAssignmentError(ValueError):
    """Operator-facing validation error for role mutations."""


def esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def normalize_role(value: Any) -> str:
    role = clean_text(value)
    if not role:
        raise RoleAssignmentError("Role cannot be empty")
    if len(role) > MAX_ROLE_LENGTH:
        raise RoleAssignmentError("Role is too long")
    return role


def normalize_session_id(value: Any) -> str:
    raw = clean_text(value)
    lowered = raw.lower()
    for prefix in SESSION_ID_PREFIXES:
        if lowered.startswith(prefix):
            raw = raw[len(prefix) :].strip()
            lowered = raw.lower()
            break
    if raw.startswith("/") or raw.endswith("/"):
        raw = raw.strip("/")
    if not raw:
        raise RoleAssignmentError("Session ID cannot be empty")
    if len(raw) > MAX_SESSION_LENGTH:
        raise RoleAssignmentError("Session ID is too long")
    if not SESSION_ID_RE.fullmatch(raw):
        raise RoleAssignmentError("Session ID must be a Claude or Codex session id")
    return raw


def safe_dom_id(value: Any) -> str:
    slug = "".join(character if character.isalnum() else "-" for character in str(value or ""))
    return "-".join(part for part in slug.split("-") if part)[:64] or "item"


def supervisor_has_role_reload(pid: Any, patch_path: Path) -> bool:
    """True only when the live supervisor process started after the reload patch was written."""
    try:
        process_id = int(pid)
        started = subprocess.check_output(
            ["ps", "-p", str(process_id), "-o", "lstart="],
            text=True,
            timeout=2,
        ).strip()
        if not started or not patch_path.is_file():
            return False
        started_at = datetime.strptime(started, "%a %b %d %H:%M:%S %Y")
        return started_at.timestamp() >= patch_path.stat().st_mtime
    except (OSError, TypeError, ValueError, subprocess.SubprocessError):
        return False


def usage_values(value: Any) -> dict[str, float | int]:
    usage = value if isinstance(value, dict) else {}
    try:
        turns = max(0, int(usage.get("turns") or 0))
    except (TypeError, ValueError):
        turns = 0
    try:
        tokens = max(0, int(usage.get("tokens") or 0))
    except (TypeError, ValueError):
        tokens = 0
    try:
        cost = max(0.0, float(usage.get("costUSD") or 0))
    except (TypeError, ValueError):
        cost = 0.0
    return {"turns": turns, "tokens": tokens, "costUSD": cost}


def summarize_usage(agents: list[dict[str, Any]]) -> dict[str, Any]:
    total: dict[str, float | int] = {"turns": 0, "tokens": 0, "costUSD": 0.0}
    grouped: dict[str, dict[str, Any]] = {}
    for agent in agents:
        usage = usage_values(agent.get("usage"))
        total["turns"] += int(usage["turns"])
        total["tokens"] += int(usage["tokens"])
        total["costUSD"] += float(usage["costUSD"])
        subscription = clean_text(agent.get("auth")) or "Unknown subscription"
        group = grouped.setdefault(
            subscription,
            {"name": subscription, "turns": 0, "tokens": 0, "costUSD": 0.0, "agents": []},
        )
        group["turns"] += int(usage["turns"])
        group["tokens"] += int(usage["tokens"])
        group["costUSD"] += float(usage["costUSD"])
        group["agents"].append(str(agent.get("id") or ""))
    return {
        "total": total,
        "subscriptions": sorted(grouped.values(), key=lambda item: str(item["name"]).lower()),
    }


def format_count(value: Any) -> str:
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return "0"


def format_cost(value: Any) -> str:
    try:
        return f"${float(value):,.4f}"
    except (TypeError, ValueError):
        return "$0.0000"


def preview(value: Any, limit: int = 120) -> str:
    text = clean_text(value)
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def display_time(value: Any) -> str:
    if isinstance(value, (int, float)):
        seconds = float(value) / 1000 if value > 10_000_000_000 else float(value)
        try:
            return datetime.fromtimestamp(seconds).astimezone().strftime("%Y-%m-%d %H:%M:%S")
        except (OSError, OverflowError, ValueError):
            return str(value)
    text = str(value or "")
    if not text:
        return "never"
    return text.replace("T", " ")[:19]


def load_json(value: Any, fallback: Any) -> Any:
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def connect_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError(f"Data source not found: {path}")
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def timestamp_key(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def conversation_identity(message: dict[str, Any]) -> str:
    thread = clean_text(message.get("thread"))
    sender = clean_text(message.get("sender"))
    recipient = clean_text(message.get("recipient")) or "all"
    participants = "|".join(sorted({sender, recipient}))
    subject = clean_text(message.get("subject"))
    if thread:
        basis = f"thread:{thread}"
    elif subject:
        basis = f"subject:{participants}:{subject}"
    else:
        basis = f"message:{message.get('id')}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:20]


def group_conversations(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for message in messages:
        identity = conversation_identity(message)
        conversation = grouped.setdefault(
            identity,
            {
                "id": identity,
                "messages": [],
                "participants": set(),
                "latest": 0.0,
                "title": "",
                "thread": clean_text(message.get("thread")),
            },
        )
        conversation["messages"].append(message)
        for participant in (message.get("sender"), message.get("recipient") or "all"):
            if participant:
                conversation["participants"].add(str(participant))
        moment = timestamp_key(message.get("ts"))
        if moment >= conversation["latest"]:
            conversation["latest"] = moment
            conversation["latest_display"] = display_time(message.get("ts"))
            conversation["latest_body"] = preview(message.get("body"), 110)
            conversation["title"] = clean_text(message.get("subject")) or conversation["thread"] or "Conversation"
    result = []
    for conversation in grouped.values():
        conversation["messages"].sort(key=lambda item: timestamp_key(item.get("ts")))
        conversation["participants"] = sorted(conversation["participants"])
        conversation["message_count"] = len(conversation["messages"])
        result.append(conversation)
    return sorted(result, key=lambda item: item["latest"], reverse=True)


class ConversationStateStore:
    """Reversible dashboard-only Archive/Trash and role assignments; source history stays intact."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"version": 1, "conversations": {}, "roles": {}, "pinned_projects": []}

    @staticmethod
    def _pinned_keys(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        keys: list[str] = []
        seen: set[str] = set()
        for item in value:
            key = clean_text(item)
            if not key or key in seen:
                continue
            seen.add(key)
            keys.append(key)
        return keys

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return self._empty()
        if not isinstance(data, dict):
            return self._empty()
        conversations = data.get("conversations")
        roles = data.get("roles")
        return {
            **data,
            "version": 1,
            "conversations": conversations if isinstance(conversations, dict) else {},
            "roles": roles if isinstance(roles, dict) else {},
            "pinned_projects": self._pinned_keys(data.get("pinned_projects")),
        }

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.tmp-{os.getpid()}")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.path)

    def status(self, project_key: str, conversation_id: str) -> str:
        with self.lock:
            project = self._load()["conversations"].get(project_key, {})
            item = project.get(conversation_id, {}) if isinstance(project, dict) else {}
            status = item.get("status") if isinstance(item, dict) else None
            return status if status in {"archived", "trash"} else "inbox"

    def set_status(self, project_key: str, conversation_id: str, status: str) -> None:
        if status not in {"inbox", "archived", "trash"}:
            raise ValueError("Unknown conversation state")
        with self.lock:
            data = self._load()
            conversations = data.setdefault("conversations", {})
            project = conversations.setdefault(project_key, {})
            if status == "inbox":
                project.pop(conversation_id, None)
                if not project:
                    conversations.pop(project_key, None)
            else:
                project[conversation_id] = {
                    "status": status,
                    "updated": datetime.now(timezone.utc).isoformat(),
                }
            self._write(data)

    def role_record(self, project_key: str, subject_id: str) -> dict[str, Any] | None:
        with self.lock:
            project = self._load()["roles"].get(project_key, {})
            item = project.get(subject_id) if isinstance(project, dict) else None
            if not isinstance(item, dict):
                return None
            role = clean_text(item.get("role"))
            if not role:
                return None
            subject = item.get("subject") if item.get("subject") in {"agent", "conversation", "session"} else "agent"
            return {
                "role": role,
                "default_role": clean_text(item.get("default_role")),
                "subject": subject,
                "agent_id": clean_text(item.get("agent_id")),
                "updated": item.get("updated"),
            }

    def session_roles(self, project_key: str) -> dict[str, dict[str, Any]]:
        with self.lock:
            project = self._load()["roles"].get(project_key, {})
            if not isinstance(project, dict):
                return {}
            records: dict[str, dict[str, Any]] = {}
            for key, item in project.items():
                record = self._role_item(item)
                if record is None or record["subject"] != "session":
                    continue
                records[str(key)] = record
            return records

    @staticmethod
    def _role_item(item: Any) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None
        role = clean_text(item.get("role"))
        if not role:
            return None
        subject = item.get("subject") if item.get("subject") in {"agent", "conversation", "session"} else "agent"
        return {
            "role": role,
            "default_role": clean_text(item.get("default_role")),
            "subject": subject,
            "agent_id": clean_text(item.get("agent_id")),
            "updated": item.get("updated"),
        }

    def set_role(
        self,
        project_key: str,
        subject_id: str,
        role: str,
        default_role: str,
        subject: str,
        agent_id: str = "",
    ) -> None:
        role = normalize_role(role)
        default_role = clean_text(default_role)
        if subject not in {"agent", "conversation", "session"}:
            raise RoleAssignmentError("Unknown role subject")
        with self.lock:
            data = self._load()
            project = data.setdefault("roles", {}).setdefault(project_key, {})
            record = {
                "role": role,
                "default_role": default_role,
                "subject": subject,
                "updated": datetime.now(timezone.utc).isoformat(),
            }
            bound = clean_text(agent_id)
            if subject == "session" and bound:
                record["agent_id"] = bound
            project[subject_id] = record
            self._write(data)

    def clear_role(self, project_key: str, subject_id: str) -> dict[str, Any] | None:
        with self.lock:
            data = self._load()
            roles = data.setdefault("roles", {})
            project = roles.get(project_key, {})
            if not isinstance(project, dict):
                return None
            record = project.pop(subject_id, None)
            if not project:
                roles.pop(project_key, None)
            self._write(data)
            return record if isinstance(record, dict) else None

    def pinned_projects(self) -> list[str]:
        with self.lock:
            return list(self._load()["pinned_projects"])

    def set_pinned(self, project_key: str, pinned: bool) -> None:
        key = clean_text(project_key)
        if not key:
            raise ValueError("Unknown project")
        with self.lock:
            data = self._load()
            current = self._pinned_keys(data.get("pinned_projects"))
            if pinned:
                if key not in current:
                    current.append(key)
            else:
                current = [item for item in current if item != key]
            data["pinned_projects"] = current
            self._write(data)


@dataclass(frozen=True)
class ProjectSource:
    key: str
    name: str
    short_name: str
    description: str
    path_label: str
    kind: str
    db_path: Path | None = None
    cli_path: Path | None = None
    status_dir: Path | None = None
    workspace_path: Path | None = None
    bus_url: str = DEFAULT_LIVE_BUS_URL
    operator_token: Path = DEFAULT_OPERATOR_TOKEN
    audit_log: Path = DEFAULT_AUDIT_LOG
    agent_bus_root: Path = DEFAULT_AGENT_BUS_ROOT

    def agent_count(self) -> int:
        if self.kind == "workspace":
            return len(self.agents())
        if self.kind == "coordinator":
            if self.db_path is None:
                return 0
            with connect_read_only(self.db_path) as connection:
                return int(connection.execute("SELECT COUNT(*) FROM agents").fetchone()[0])
        return len(self.agents())

    def message_count(self) -> int:
        if self.kind == "workspace":
            return len(self.messages())
        if self.db_path is None:
            return 0
        with connect_read_only(self.db_path) as connection:
            return int(connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0])

    def summary(self) -> dict[str, Any]:
        if self.kind == "workspace" and (self.workspace_path is None or not self.workspace_path.is_dir()):
            return {
                "key": self.key,
                "name": self.name,
                "short_name": self.short_name,
                "description": self.description,
                "path": self.path_label,
                "kind": self.kind,
                "agents": 0,
                "messages": 0,
                "available": False,
                "error": f"Project folder not found: {self.path_label}",
            }
        try:
            return {
                "key": self.key,
                "name": self.name,
                "short_name": self.short_name,
                "description": self.description,
                "path": self.path_label,
                "kind": self.kind,
                "agents": self.agent_count(),
                "messages": self.message_count(),
                "available": True,
                "error": "",
            }
        except (OSError, sqlite3.Error, ValueError) as error:
            return {
                "key": self.key,
                "name": self.name,
                "short_name": self.short_name,
                "description": self.description,
                "path": self.path_label,
                "kind": self.kind,
                "agents": 0,
                "messages": 0,
                "available": False,
                "error": str(error),
            }

    def agents(self) -> list[dict[str, Any]]:
        if self.kind == "workspace":
            return self._workspace_agents()
        if self.kind == "coordinator":
            return self._coordinator_agents()
        return self._agent_bus_agents()

    def _coordinator_agents(self) -> list[dict[str, Any]]:
        if self.db_path is None:
            return []
        query = """
            SELECT a.id, a.display_name, a.model, a.role, a.capabilities,
                   a.parent_id, a.status, a.heartbeat_ts, a.updated_ts,
                   (SELECT MAX(m.ts) FROM messages m
                    WHERE m.sender = a.id OR m.recipient = a.id) AS last_message
            FROM agents a
            ORDER BY CASE a.status
                WHEN 'working' THEN 0 WHEN 'waiting_review' THEN 1
                WHEN 'idle' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
                COALESCE(NULLIF(a.display_name, ''), a.id)
        """
        with connect_read_only(self.db_path) as connection:
            rows = connection.execute(query).fetchall()
        agents: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["name"] = item.get("display_name") or item["id"]
            item["capabilities"] = load_json(item.get("capabilities"), [])
            item["last_active"] = item.get("heartbeat_ts") or item.get("last_message") or item.get("updated_ts")
            item["doing"] = ", ".join(item["capabilities"][:3]) or "No capabilities reported"
            agents.append(item)
        return agents

    def _agent_bus_agents(self) -> list[dict[str, Any]]:
        if self.db_path is None:
            return []
        query = """
            WITH names AS (
                SELECT sender AS id FROM messages
                UNION
                SELECT recipient AS id FROM messages WHERE recipient != 'all'
                UNION
                SELECT agent AS id FROM cursors
            )
            SELECT names.id,
                   (SELECT MAX(ts) FROM messages WHERE sender = names.id) AS last_message,
                   (SELECT COUNT(*) FROM messages WHERE sender = names.id) AS sent_count
            FROM names
            WHERE names.id IS NOT NULL AND names.id != '' AND names.id != 'all'
            ORDER BY names.id
        """
        with connect_read_only(self.db_path) as connection:
            rows = connection.execute(query).fetchall()
        status_map = self._load_agent_bus_status()
        agents = []
        for row in rows:
            item = dict(row)
            status = status_map.get(item["id"], {})
            item.update(
                {
                    "name": status.get("display_name") or status.get("name") or item["id"],
                    "model": status.get("model") or "",
                    "role": status.get("role") or "message peer",
                    "parent_id": status.get("parent") or status.get("parent_id") or "",
                    "status": status.get("status") or "unknown",
                    "doing": status.get("doing") or f"{item['sent_count']} messages sent",
                    "last_active": status.get("updated") or item.get("last_message"),
                }
            )
            agents.append(item)
        return agents

    def _load_agent_bus_status(self) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        if self.status_dir is None or not self.status_dir.is_dir():
            return result
        for path in self.status_dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict):
                result[path.stem] = data
        return result

    def _live_snapshot(self) -> dict[str, Any]:
        now = monotonic()
        cached = LIVE_SNAPSHOT_CACHE.get(self.bus_url)
        if cached is not None and now - cached[0] < LIVE_SNAPSHOT_TTL_SECONDS:
            return cached[1]
        request = urllib.request.Request(
            f"{self.bus_url.rstrip('/')}/snapshot",
            data=b"{}",
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                payload = json.load(response)
            if not isinstance(payload, dict):
                raise ValueError("AgentBus returned an invalid snapshot")
            payload["_reachable"] = True
            payload["_observedAt"] = datetime.now(timezone.utc).isoformat()
            LIVE_LAST_GOOD_SNAPSHOT[self.bus_url] = dict(payload)
        except (OSError, urllib.error.URLError, ValueError) as error:
            payload = dict(LIVE_LAST_GOOD_SNAPSHOT.get(self.bus_url, {"roster": [], "messages": []}))
            payload["_reachable"] = False
            payload["_error"] = clean_text(error) or "AgentBus broker unavailable"
        if not isinstance(payload, dict):
            payload = {"roster": [], "messages": []}
        LIVE_SNAPSHOT_CACHE[self.bus_url] = (now, payload)
        return payload

    def _workspace_roster(self, snapshot: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        if self.workspace_path is None:
            return []
        expected = str(self.workspace_path.resolve())
        data = snapshot if snapshot is not None else self._live_snapshot()
        roster = data.get("roster", [])
        if not isinstance(roster, list):
            return []
        return [
            item
            for item in roster
            if isinstance(item, dict)
            and item.get("workdir")
            and str(Path(str(item["workdir"])).resolve()) == expected
        ]

    def _workspace_agents(self, snapshot: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        agents = []
        data = snapshot if snapshot is not None else self._live_snapshot()
        reachable = data.get("_reachable", True) is not False
        roster = self._workspace_roster(data)
        cli_counts: dict[str, int] = {}
        for item in roster:
            cli = clean_text(item.get("cli") or item.get("harness")).lower()
            if cli:
                cli_counts[cli] = cli_counts.get(cli, 0) + 1
        for item in roster:
            pending = int(item.get("pendingMessages") or 0)
            current = item.get("currentTaskId")
            if current:
                doing = f"Task {current}"
            elif pending:
                doing = f"{pending} pending message{'s' if pending != 1 else ''}"
            elif item.get("blocked"):
                doing = "Waiting on AgentBus"
            else:
                doing = "No active task"
            seconds = int(item.get("lastSeenSecondsAgo") or 0)
            cli = clean_text(item.get("cli") or item.get("harness")).lower()
            usage = usage_values(item.get("usage"))
            agents.append(
                {
                    "id": item.get("id") or "",
                    "name": item.get("id") or "",
                    "model": item.get("model") or "",
                    "role": item.get("role") or "worker",
                    "parent_id": "",
                    "status": "stale" if not reachable else ("stalled" if item.get("stalled") else item.get("status") or "unknown"),
                    "doing": doing,
                    "last_active": f"{seconds}s ago",
                    "supervisor_pid": item.get("supervisorPid"),
                    "harness": item.get("harness") or "",
                    "cli": cli,
                    "auth": clean_text(item.get("auth")) or "Unknown subscription",
                    "workdir": clean_text(item.get("workdir")),
                    "usage": usage,
                    "blocked": bool(item.get("blocked")),
                    "stalled": bool(item.get("stalled")),
                    "pending_messages": pending,
                    "controllable": reachable and bool(item.get("supervisorPid")),
                    "session_available": reachable and bool(item.get("workdir")) and int(usage["turns"]) > 0 and cli_counts.get(cli) == 1 and cli in {"claude", "codex", "grok", "kimi", "opencode"},
                    "session_label": f"Open latest {cli.title()} session" if cli else "Open latest session",
                }
            )
        return sorted(agents, key=lambda item: str(item["id"]).lower())

    def _audit_messages(self) -> list[dict[str, Any]]:
        try:
            stat = self.audit_log.stat()
        except OSError:
            return []
        cache_key = str(self.audit_log)
        cached = AUDIT_MESSAGE_CACHE.get(cache_key)
        if cached is not None and cached[:2] == (stat.st_mtime_ns, stat.st_size):
            return list(cached[2])
        messages: list[dict[str, Any]] = []
        try:
            with self.audit_log.open(encoding="utf-8") as stream:
                for line in stream:
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(record, dict) or record.get("kind") != "message":
                        continue
                    item = record.get("data")
                    if not isinstance(item, dict):
                        continue
                    messages.append(
                        {
                            "id": item.get("id"),
                            "ts": item.get("ts") or record.get("ts"),
                            "sender": item.get("from") or "",
                            "recipient": item.get("to") or "",
                            "subject": item.get("subject") or "",
                            "body": item.get("body") or "",
                            "thread": item.get("taskId") or "",
                            "priority": item.get("type") or "normal",
                            "requires_ack": 0,
                        }
                    )
        except OSError:
            return []
        AUDIT_MESSAGE_CACHE[cache_key] = (stat.st_mtime_ns, stat.st_size, messages)
        return list(messages)

    @staticmethod
    def _snapshot_message(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item.get("id"),
            "ts": item.get("ts"),
            "sender": item.get("from") or "",
            "recipient": item.get("to") or "",
            "subject": item.get("subject") or "",
            "body": item.get("body") or "",
            "thread": item.get("taskId") or "",
            "priority": item.get("type") or "normal",
            "requires_ack": 0,
        }

    def messages(self, limit: int | None = None) -> list[dict[str, Any]]:
        if self.kind == "workspace":
            snapshot = self._live_snapshot()
            agent_ids = {
                str(item.get("id"))
                for item in self._workspace_roster(snapshot)
                if item.get("id")
            }
            live_messages = []
            for item in snapshot.get("messages", []):
                if not isinstance(item, dict):
                    continue
                sender = str(item.get("from") or "")
                recipient = str(item.get("to") or "")
                if sender not in agent_ids and recipient not in agent_ids:
                    continue
                live_messages.append(self._snapshot_message(item))
            messages = live_messages
            if self.workspace_path is not None and self.workspace_path.resolve() == self.agent_bus_root.resolve():
                messages = self._audit_messages() + live_messages
            deduplicated: dict[str, dict[str, Any]] = {}
            for message in messages:
                message_id = clean_text(message.get("id"))
                identity = message_id or hashlib.sha256(
                    json.dumps(message, sort_keys=True, default=str).encode("utf-8")
                ).hexdigest()
                deduplicated[identity] = message
            result = sorted(deduplicated.values(), key=lambda item: timestamp_key(item.get("ts")), reverse=True)
            return result if limit is None else result[:limit]
        if self.db_path is None:
            return []
        if self.kind == "coordinator":
            query = """
                SELECT id, ts, sender, recipient, subject, body, thread,
                       priority, requires_ack
                FROM messages ORDER BY id DESC
            """
        else:
            query = """
                SELECT id, ts, sender, recipient, COALESCE(subject, '') AS subject,
                       body, COALESCE(thread, '') AS thread,
                       'normal' AS priority, 0 AS requires_ack
                FROM messages ORDER BY id DESC
            """
        with connect_read_only(self.db_path) as connection:
            result = [dict(row) for row in connection.execute(query).fetchall()]
        return result if limit is None else result[:limit]

    def send(self, sender: str, recipient: str, subject: str, thread: str, body: str) -> None:
        if self.kind == "workspace":
            self._send_to_workspace(recipient, subject, body)
            return
        if self.cli_path is None or not self.cli_path.is_file():
            raise RuntimeError(f"Message command not found: {self.cli_path}")
        if self.db_path is None:
            raise RuntimeError("Message database is not configured")
        if self.kind == "coordinator":
            command = [
                str(self.cli_path), "--db", str(self.db_path), "send",
                "--from", sender, "--body", body,
            ]
            if recipient and recipient != "all":
                command += ["--to", recipient]
            if subject:
                command += ["--subject", subject]
            if thread:
                command += ["--thread", thread]
            env = os.environ.copy()
        else:
            subcommand = "send" if recipient and recipient != "all" else "broadcast"
            command = [sys.executable, str(self.cli_path), "cli", subcommand, "--from", sender, "--body", body]
            if subcommand == "send":
                command += ["--to", recipient]
            if subject:
                command += ["--subject", subject]
            if thread and subcommand == "send":
                command += ["--thread", thread]
            env = os.environ.copy()
            env["AGENT_COMMS_DB"] = str(self.db_path)
        completed = subprocess.run(
            command,
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if completed.returncode != 0:
            detail = clean_text(completed.stderr or completed.stdout) or f"exit {completed.returncode}"
            raise RuntimeError(detail)

    def _send_to_workspace(self, recipient: str, subject: str, body: str) -> None:
        agent_ids = [str(item["id"]) for item in self._workspace_agents() if item.get("id")]
        if not agent_ids:
            raise RuntimeError("No live AgentBus agents are attached to this project")
        if recipient == "all":
            target = ",".join(agent_ids)
        elif recipient in agent_ids:
            target = recipient
        else:
            raise RuntimeError("Recipient is not attached to this project")
        result = self._operator_call(
            "/send",
            {
                "to": target,
                "subject": subject or "Dashboard message",
                "body": body,
                "type": "info",
            },
        )
        if not result.get("delivered"):
            raise RuntimeError("AgentBus did not deliver the message")

    def _operator_call(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            token = self.operator_token.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise RuntimeError(f"AgentBus operator token unavailable: {error}") from error
        body = dict(payload)
        body["token"] = token
        request = urllib.request.Request(
            f"{self.bus_url.rstrip('/')}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(clean_text(detail) or f"AgentBus returned HTTP {error.code}") from error
        except (OSError, urllib.error.URLError, ValueError) as error:
            raise RuntimeError(f"AgentBus request failed: {error}") from error
        if not isinstance(result, dict):
            raise RuntimeError("AgentBus returned an invalid response")
        return result

    def agent_definitions(self) -> list[dict[str, Any]]:
        if self.kind != "workspace":
            return []
        registry = self.agent_bus_root / "agents.json"
        try:
            data = json.loads(registry.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(data, dict):
            return []
        definitions = []
        for agent_id, item in data.items():
            if not isinstance(item, dict):
                continue
            definitions.append(
                {
                    "id": str(agent_id),
                    "harness": clean_text(item.get("harness")),
                    "model": clean_text(item.get("model")),
                    "role": clean_text(item.get("role")) or "worker",
                    "description": clean_text(item.get("description")),
                }
            )
        return sorted(definitions, key=lambda item: item["id"].lower())

    def write_registry_role(self, agent_id: str, role: str) -> bool:
        path = self.agent_bus_root / "agents.json"
        with REGISTRY_LOCK:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise RoleAssignmentError(f"Could not read agent registry: {error}") from error
            if not isinstance(data, dict) or agent_id not in data or not isinstance(data[agent_id], dict):
                return False
            if clean_text(data[agent_id].get("role")) == role:
                return True
            data[agent_id]["role"] = role
            mode = stat.S_IMODE(path.stat().st_mode)
            temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.chmod(temporary, mode)
            os.replace(temporary, path)
            return True

    def listed_agents(self, snapshot: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        if self.kind == "workspace":
            live = self._workspace_agents(snapshot)
            registry = {item["id"]: item for item in self.agent_definitions()}
            for agent in live:
                agent["in_registry"] = str(agent.get("id")) in registry
                agent["listed"] = "live"
            seen = {str(agent.get("id")) for agent in live}
            extras = []
            for item in self.agent_definitions():
                if item["id"] in seen:
                    continue
                extras.append(
                    {
                        "id": item["id"],
                        "name": item["id"],
                        "model": item["model"],
                        "role": item["role"],
                        "parent_id": "",
                        "status": "registered",
                        "doing": "Registered AgentBus identity · not attached here",
                        "last_active": "",
                        "in_registry": True,
                        "listed": "registered",
                        "harness": item["harness"],
                        "usage": usage_values({}),
                        "controllable": False,
                        "session_available": False,
                        "supervisor_pid": None,
                    }
                )
            return live + extras
        agents = self.agents()
        for agent in agents:
            agent["in_registry"] = False
            agent["listed"] = "coordinator" if self.kind == "coordinator" else "liminal"
        return agents

    def roster_entry(self, agent_id: str) -> dict[str, Any] | None:
        if self.kind != "workspace":
            return None
        roster = self._live_snapshot().get("roster", [])
        if not isinstance(roster, list):
            return None
        return next(
            (item for item in roster if isinstance(item, dict) and str(item.get("id")) == agent_id),
            None,
        )

    def attached_agent_ids(self) -> set[str]:
        if self.kind != "workspace":
            return set()
        roster = self._live_snapshot().get("roster", [])
        if not isinstance(roster, list):
            return set()
        return {
            str(item.get("id"))
            for item in roster
            if isinstance(item, dict) and item.get("id")
        }

    def start_agent(self, agent_id: str) -> int:
        if self.kind != "workspace" or self.workspace_path is None:
            raise RuntimeError("This source does not support agent controls")
        definitions = {item["id"]: item for item in self.agent_definitions()}
        if agent_id not in definitions:
            raise RuntimeError("Unknown AgentBus agent")
        if agent_id in self.attached_agent_ids():
            raise RuntimeError(f"{agent_id} is already attached to AgentBus")
        node = shutil.which("node")
        daemonize = self.agent_bus_root / "scripts" / "daemonize.js"
        cli = self.agent_bus_root / "dist" / "cli.js"
        if not node or not daemonize.is_file() or not cli.is_file():
            raise RuntimeError("AgentBus runtime is incomplete")
        log_dir = self.operator_token.parent / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"supervisor-{agent_id}.log"
        completed = subprocess.run(
            [
                node,
                str(daemonize),
                str(log_path),
                str(cli),
                "supervise",
                agent_id,
                str(self.workspace_path),
            ],
            cwd=self.agent_bus_root,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(clean_text(completed.stderr or completed.stdout) or "AgentBus supervisor did not start")
        try:
            pid = int(clean_text(completed.stdout).splitlines()[-1])
        except (IndexError, ValueError) as error:
            raise RuntimeError("AgentBus supervisor started without returning a PID") from error
        LIVE_SNAPSHOT_CACHE.pop(self.bus_url, None)
        sleep(0.35)
        return pid

    def stop_agent(self, agent_id: str) -> None:
        if self.kind != "workspace":
            raise RuntimeError("This source does not support agent controls")
        attached = {
            str(item.get("id")): item
            for item in self._workspace_roster()
            if item.get("id") and item.get("supervisorPid")
        }
        if agent_id not in attached:
            raise RuntimeError(f"No controllable supervisor is attached for {agent_id}")
        result = self._operator_call("/kill", {"agentId": agent_id})
        if not result.get("ok"):
            raise RuntimeError(f"AgentBus could not stop {agent_id}")
        LIVE_SNAPSHOT_CACHE.pop(self.bus_url, None)

    def stop_all(self) -> int:
        controllable = [
            str(item.get("id"))
            for item in self._workspace_roster()
            if item.get("id") and item.get("supervisorPid")
        ]
        for agent_id in controllable:
            self.stop_agent(agent_id)
        return len(controllable)

    def open_session(self, agent_id: str) -> Path:
        if self.kind != "workspace" or self.workspace_path is None:
            raise RuntimeError("This source does not support Terminal sessions")
        snapshot = self._live_snapshot()
        if snapshot.get("_reachable", True) is False:
            raise RuntimeError("AgentBus broker is unavailable; session metadata may be stale")
        roster = self._workspace_roster(snapshot)
        attached = {
            str(item.get("id")): item
            for item in roster
            if item.get("id") and item.get("workdir")
        }
        agent = attached.get(agent_id)
        if agent is None:
            raise RuntimeError(f"No live session is attached for {agent_id}")
        workdir = Path(str(agent["workdir"])).resolve()
        if workdir != self.workspace_path.resolve():
            raise RuntimeError("Agent session is not attached to this project")
        cli = clean_text(agent.get("cli") or agent.get("harness")).lower()
        resume_commands = {
            "claude": ("claude", "--continue"),
            "codex": ("codex", "resume", "--last"),
            "grok": ("grok", "--continue"),
            "kimi": ("kimi", "-c"),
            "opencode": ("opencode", "--continue"),
        }
        command = resume_commands.get(cli)
        if command is None:
            raise RuntimeError(f"No resume command is known for {cli or 'this agent'}")
        same_cli = [
            item
            for item in roster
            if clean_text(item.get("cli") or item.get("harness")).lower() == cli
        ]
        if len(same_cli) != 1:
            raise RuntimeError(f"Latest {cli.title()} session is ambiguous in this project")
        if int(usage_values(agent.get("usage"))["turns"]) <= 0:
            raise RuntimeError(f"{agent_id} has not completed a resumable turn yet")
        open_dir = self.operator_token.parent / "open"
        open_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(open_dir, 0o700)
        safe_name = "".join(character if character.isalnum() or character in "-_" else "-" for character in agent_id)
        safe_name = safe_name.strip("-")[:48] or "agent"
        command_path = open_dir / f"dashboard-{safe_name}-session.command"
        temporary = open_dir / f".{command_path.name}.tmp-{os.getpid()}"
        title = f"{agent_id} — live session"
        message = f"Resuming {agent_id}'s session in {workdir}"
        script = "\n".join(
            [
                "#!/bin/bash",
                f"cd -- {shlex.quote(str(workdir))} || exit 1",
                f"printf '\\033]0;%s\\007' {shlex.quote(title)}",
                f"printf '%s\\n' {shlex.quote(message)}",
                " ".join(shlex.quote(part) for part in command),
                "",
            ]
        )
        temporary.write_text(script, encoding="utf-8")
        os.chmod(temporary, 0o700)
        os.replace(temporary, command_path)
        completed = subprocess.run(
            ["/usr/bin/open", str(command_path)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(clean_text(completed.stderr or completed.stdout) or "Terminal did not open")
        return command_path


class Dashboard:
    def __init__(self, projects: list[ProjectSource], state_store: ConversationStateStore, settings: argparse.Namespace | None = None) -> None:
        self.projects = {project.key: project for project in projects}
        self.state_store = state_store
        self.csrf_token = secrets.token_urlsafe(24)
        self.settings = settings

    def summaries(self) -> list[dict[str, Any]]:
        return self.catalog()

    def catalog(self) -> list[dict[str, Any]]:
        pinned_keys = self.state_store.pinned_projects()
        pinned_rank = {key: index for index, key in enumerate(pinned_keys)}
        items = []
        for project in self.projects.values():
            item = project.summary()
            item["kind"] = project.kind
            item["pinned"] = item["key"] in pinned_rank
            items.append(item)

        def sort_key(item: dict[str, Any]) -> tuple[int, int, str]:
            if item["pinned"]:
                return (0, pinned_rank.get(item["key"], 10_000), item["name"].casefold())
            if item.get("kind") != "workspace":
                return (1, 0, item["name"].casefold())
            return (2, 0, item["name"].casefold())

        return sorted(items, key=sort_key)

    def project(self, key: str) -> ProjectSource:
        project = self.projects.get(key)
        if project is None:
            raise KeyError(key)
        return project

    def known_agent_ids(self, project: ProjectSource) -> set[str]:
        return {str(agent.get("id")) for agent in project.listed_agents() if agent.get("id")}

    def known_conversation_ids(self, project: ProjectSource) -> set[str]:
        return {item["id"] for item in group_conversations(project.messages())}

    def apply_saved_agent_roles(self, project: ProjectSource, agents: list[dict[str, Any]]) -> list[dict[str, Any]]:
        registry = {item["id"]: item for item in project.agent_definitions()}
        session_roles = self.state_store.session_roles(project.key)
        bound_sessions = {
            clean_text(record.get("agent_id")): session_id
            for session_id, record in session_roles.items()
            if clean_text(record.get("agent_id"))
        }
        for agent in agents:
            agent_id = str(agent.get("id") or "")
            record = self.state_store.role_record(project.key, agent_id)
            if agent_id in registry:
                agent["in_registry"] = True
                agent["role"] = clean_text(registry[agent_id].get("role")) or agent.get("role") or "worker"
            elif record:
                agent["role"] = record["role"]
            if agent_id in bound_sessions:
                agent["session_id"] = bound_sessions[agent_id]
            effect, label = self.agent_role_effect(project, agent)
            agent["role_effect"] = effect
            agent["role_effect_label"] = label
        return agents

    def session_assignment_rows(self, project: ProjectSource, agents: list[dict[str, Any]]) -> list[dict[str, Any]]:
        listed = {str(agent.get("id")) for agent in agents if agent.get("id")}
        rows = []
        for session_id, record in self.state_store.session_roles(project.key).items():
            bound = clean_text(record.get("agent_id"))
            if bound and bound in listed:
                continue
            if session_id in listed:
                continue
            rows.append(
                {
                    "id": session_id,
                    "name": "Session",
                    "session_id": session_id,
                    "model": "",
                    "role": record["role"],
                    "status": "session",
                    "doing": f"Bound to {bound}" if bound else "Assigned by session ID · not bound to a live agent",
                    "last_active": record.get("updated") or "",
                    "listed": "session",
                    "in_registry": False,
                    "harness": "",
                    "usage": usage_values({}),
                    "controllable": False,
                    "session_available": False,
                    "supervisor_pid": None,
                    "role_effect": "next-turn" if bound else "metadata",
                    "role_effect_label": "Applies on next turn" if bound else "Operator metadata",
                }
            )
        return sorted(rows, key=lambda item: str(item["id"]).lower())

    def assign_session_role(self, project: ProjectSource, session_id: Any, role: Any, agent_id: Any = "") -> str:
        session_id = normalize_session_id(session_id)
        role = normalize_role(role)
        bound = clean_text(agent_id)[:80]
        agents = {str(item.get("id")): item for item in project.listed_agents() if item.get("id")}
        if bound:
            agent = agents.get(bound)
            if agent is None:
                raise RoleAssignmentError("Unknown agent")
            existing_agent = self.state_store.role_record(project.key, bound)
            default_role = clean_text((existing_agent or {}).get("default_role")) or clean_text(agent.get("role")) or role
            if agent.get("in_registry"):
                project.write_registry_role(bound, role)
            self.state_store.set_role(project.key, bound, role, default_role, "agent")
        existing = self.state_store.role_record(project.key, session_id)
        default_role = clean_text((existing or {}).get("default_role"))
        if bound:
            default_role = default_role or clean_text(agents.get(bound, {}).get("role"))
        self.state_store.set_role(project.key, session_id, role, default_role, "session", bound)
        return role

    def reset_session_role(self, project: ProjectSource, session_id: Any) -> str:
        session_id = normalize_session_id(session_id)
        existing = self.state_store.role_record(project.key, session_id)
        if existing is None:
            raise RoleAssignmentError("Unknown session")
        bound = clean_text(existing.get("agent_id"))
        self.state_store.clear_role(project.key, session_id)
        if bound:
            agents = {str(item.get("id")): item for item in project.listed_agents() if item.get("id")}
            if bound in agents:
                return self.reset_agent_role(project, bound)
        return clean_text(existing.get("default_role")) or ""

    def agent_role_effect(self, project: ProjectSource, agent: dict[str, Any]) -> tuple[str, str]:
        if not agent.get("in_registry"):
            return ("metadata", "Operator metadata")
        live = project.roster_entry(str(agent.get("id") or ""))
        assigned = clean_text(agent.get("role"))
        if live and live.get("supervisorPid"):
            live_role = clean_text(live.get("role"))
            if live_role and assigned and live_role == assigned:
                return ("active", "Active now")
            if supervisor_has_role_reload(live.get("supervisorPid"), project.agent_bus_root / "dist" / "supervisor.js"):
                return ("next-turn", "Applies on next turn")
            return ("restart", "Requires restart")
        if live:
            return ("restart", "Requires restart")
        return ("active", "Active now")

    def assign_agent_role(self, project: ProjectSource, agent_id: str, role: Any) -> str:
        agent_id = clean_text(agent_id)[:80]
        role = normalize_role(role)
        agents = {str(item.get("id")): item for item in project.listed_agents() if item.get("id")}
        agent = agents.get(agent_id)
        if agent is None:
            raise RoleAssignmentError("Unknown agent")
        existing = self.state_store.role_record(project.key, agent_id)
        default_role = clean_text((existing or {}).get("default_role")) or clean_text(agent.get("role")) or role
        if agent.get("in_registry"):
            project.write_registry_role(agent_id, role)
        self.state_store.set_role(project.key, agent_id, role, default_role, "agent")
        return role

    def reset_agent_role(self, project: ProjectSource, agent_id: str) -> str:
        agent_id = clean_text(agent_id)[:80]
        agents = {str(item.get("id")): item for item in project.listed_agents() if item.get("id")}
        agent = agents.get(agent_id)
        if agent is None:
            raise RoleAssignmentError("Unknown agent")
        existing = self.state_store.role_record(project.key, agent_id)
        default_role = clean_text((existing or {}).get("default_role")) or clean_text(agent.get("role")) or "worker"
        default_role = normalize_role(default_role)
        if agent.get("in_registry"):
            project.write_registry_role(agent_id, default_role)
        self.state_store.clear_role(project.key, agent_id)
        return default_role

    def assign_conversation_role(self, project: ProjectSource, conversation_id: str, role: Any) -> str:
        conversation_id = clean_text(conversation_id)[:80]
        role = normalize_role(role)
        if conversation_id not in self.known_conversation_ids(project):
            raise RoleAssignmentError("Unknown conversation")
        existing = self.state_store.role_record(project.key, conversation_id)
        default_role = clean_text((existing or {}).get("default_role"))
        self.state_store.set_role(project.key, conversation_id, role, default_role, "conversation")
        return role

    def reset_conversation_role(self, project: ProjectSource, conversation_id: str) -> str:
        conversation_id = clean_text(conversation_id)[:80]
        if conversation_id not in self.known_conversation_ids(project):
            raise RoleAssignmentError("Unknown conversation")
        existing = self.state_store.role_record(project.key, conversation_id)
        default_role = clean_text((existing or {}).get("default_role"))
        self.state_store.clear_role(project.key, conversation_id)
        return default_role

    def role_presets_datalist(self) -> str:
        options = "".join(f'<option value="{esc(name)}"></option>' for name in ROLE_PRESETS)
        return f'<datalist id="role-presets">{options}</datalist>'

    def render_role_control(
        self,
        project: ProjectSource,
        subject: str,
        subject_id: str,
        current_role: str,
        effect_kind: str,
        effect_label: str,
        suffix: str = "row",
        box: str = "",
    ) -> str:
        if subject == "session":
            section = "agents"
            field = "session_id"
        elif subject == "agent":
            section = "agents"
            field = "agent_id"
        else:
            section = "conversations"
            field = "conversation_id"
        control_id = f"role-{subject}-{safe_dom_id(subject_id)}-{suffix}"
        box_field = f'<input type="hidden" name="box" value="{esc(box)}">' if subject == "conversation" and box else ""
        return f"""<div class="role-control">
          <div class="role-control-row">
            <form class="role-save-form" method="post" action="/project/{esc(project.key)}/{section}/set-role">
              <input type="hidden" name="csrf" value="{esc(self.csrf_token)}">
              <input type="hidden" name="{field}" value="{esc(subject_id)}">
              {box_field}
              <label class="sr-only" for="{esc(control_id)}">Role for {esc(subject_id)}</label>
              <div class="role-control-fields">
                <input id="{esc(control_id)}" name="role" list="role-presets" value="{esc(current_role)}" maxlength="{MAX_ROLE_LENGTH}" autocomplete="off" required>
                <button class="btn btn-small" type="submit">Save</button>
              </div>
            </form>
            <form class="role-reset-form" method="post" action="/project/{esc(project.key)}/{section}/reset-role">
              <input type="hidden" name="csrf" value="{esc(self.csrf_token)}">
              <input type="hidden" name="{field}" value="{esc(subject_id)}">
              {box_field}
              <button class="btn btn-quiet btn-small" type="submit">Reset</button>
            </form>
          </div>
          <p class="role-effect role-effect-{esc(effect_kind)}">{esc(effect_label)}</p>
        </div>"""

    def project_filter_text(self, item: dict[str, Any]) -> str:
        return clean_text(
            " ".join(
                str(item.get(key, ""))
                for key in ("name", "short_name", "path", "description", "kind")
            )
        ).lower()

    def render_project_pin_form(self, item: dict[str, Any]) -> str:
        pinned = bool(item.get("pinned"))
        action = "unpin" if pinned else "pin"
        label = "Unpin" if pinned else "Pin"
        return (
            f'<form class="project-pin-form" method="post" action="/project/{esc(item["key"])}/flags/{action}" data-project-pin>'
            f'<input type="hidden" name="csrf" value="{esc(self.csrf_token)}">'
            f'<button type="submit" aria-pressed="{"true" if pinned else "false"}" aria-label="{label} {esc(item["short_name"])}">{label}</button>'
            f"</form>"
        )

    def render_project_nav_item(self, item: dict[str, Any], project_key: str) -> str:
        selected_class = " selected-project" if project_key == item["key"] else ""
        pinned_class = " is-pinned" if item.get("pinned") else ""
        return (
            f'<div class="project-nav-item{pinned_class}" data-project-item data-project-key="{esc(item["key"])}" '
            f'data-filter-text="{esc(self.project_filter_text(item))}" data-pinned="{"1" if item.get("pinned") else "0"}">'
            f'<a class="nav-link project-nav-link{selected_class}" href="/project/{esc(item["key"])}" title="{esc(item["name"])}">'
            f'<span class="nav-glyph">{"*" if item.get("pinned") else "›"}</span><span>{esc(item["short_name"])}</span>'
            f'<span class="nav-count">{item["agents"]}</span></a>'
            f"{self.render_project_pin_form(item)}</div>"
        )

    def render_project_strip(self, item: dict[str, Any]) -> str:
        error = (
            f'<span class="unavailable">{esc(item["error"])}</span>'
            if not item.get("available") and item.get("error")
            else ""
        )
        return (
            f'<article class="project-strip" data-project-item data-project-key="{esc(item["key"])}" '
            f'data-filter-text="{esc(self.project_filter_text(item))}" data-pinned="{"1" if item.get("pinned") else "0"}">'
            f'<a class="project-strip-open" href="/project/{esc(item["key"])}">'
            f'<span class="project-strip-name">{esc(item["name"])}</span>'
            f'<span class="project-strip-path">{esc(item["path"])}</span>'
            f'<span class="project-strip-meta"><span><b>{item["agents"]}</b> agents</span>'
            f'<span><b>{item["messages"]}</b> messages</span></span>{error}</a>'
            f"{self.render_project_pin_form(item)}</article>"
        )

    def render_project_bay(self, bay_id: str, title: str, items: list[dict[str, Any]]) -> str:
        if not items and bay_id != "pinned":
            return ""
        if not items:
            rows = '<p class="project-bay-empty">Nothing pinned yet. Pin a project to keep it at the top.</p>'
        else:
            rows = "".join(self.render_project_strip(item) for item in items)
        return (
            f'<section class="project-bay" data-project-bay="{esc(bay_id)}" aria-labelledby="{esc(bay_id)}-title">'
            f'<h2 id="{esc(bay_id)}-title">{esc(title)}</h2>'
            f'<div class="project-bay-list">{rows}</div></section>'
        )

    def render_project_register(self) -> str:
        items = self.catalog()
        pinned = [item for item in items if item.get("pinned")]
        sources = [item for item in items if not item.get("pinned") and item.get("kind") != "workspace"]
        local = [item for item in items if not item.get("pinned") and item.get("kind") == "workspace"]
        return f"""
          <section class="project-register" aria-label="Project register">
            <div class="project-toolbar">
              <label class="project-search">
                <span class="sr-only">Search projects</span>
                <input type="search" data-project-search placeholder="Search projects" autocomplete="off" spellcheck="false">
              </label>
              <p class="project-tally"><span data-project-count>{len(items)}</span> of {len(items)}</p>
            </div>
            <p class="project-empty" data-project-empty hidden>No projects match that search.</p>
            {self.render_project_bay("pinned", "Pinned", pinned)}
            {self.render_project_bay("sources", "Coordination", sources)}
            {self.render_project_bay("local", "Local", local)}
          </section>
        """

    def shell(self, title: str, body: str, project_key: str = "", active: str = "projects") -> str:
        summaries = self.catalog()
        project = self.projects.get(project_key)
        project_links = [self.render_project_nav_item(summary, project_key) for summary in summaries]
        section_links = ""
        mobile_context = ""
        if project is not None:
            summary = next(item for item in summaries if item["key"] == project.key)
            active_label = {"project": "Overview", "agents": "Agents", "messages": "Conversations"}.get(active, "Overview")
            mobile_context = (
                f'<nav class="mobile-context" aria-label="Breadcrumb"><a href="/">Projects</a><span>/</span>'
                f'<a href="/project/{esc(project.key)}">{esc(project.short_name)}</a><span>/</span>'
                f'<strong>{esc(active_label)}</strong></nav>'
            )
            section_links = f"""
              <div class="nav-label">Workspace</div>
              <a class="nav-link" href="/project/{esc(project.key)}/agents"{' aria-current="page"' if active == 'agents' else ''}>
                <span class="nav-glyph">A</span><span>Agents</span><span class="nav-count">{summary['agents']}</span>
              </a>
              <a class="nav-link" href="/project/{esc(project.key)}/messages"{' aria-current="page"' if active == 'messages' else ''}>
                <span class="nav-glyph">C</span><span>Conversations</span><span class="nav-count">{summary['messages']}</span>
              </a>
            """
        return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>{esc(title)} — Agent Bus</title>
  <script src="/assets/theme.js?v=nav-motion"></script>
  <link rel="stylesheet" href="/assets/dashboard.css?v=portable-2">
  <script src="/assets/dashboard.js?v=portable-2" defer></script>
</head>
<body data-project="{esc(project_key)}" data-view="{esc(active)}">
  <a class="skip-link" href="#content">Skip to content</a>
  <div class="app-shell">
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <div class="sidebar-head">
        <div class="sidebar-head-row">
          <a class="brand" href="/">
            <span class="brand-mark" aria-hidden="true"><img src="/assets/b-logo.png?v=cat" alt=""></span>
            <span class="brand-copy"><strong>Agent Bus</strong><small>Local operations</small></span>
          </a>
          <button class="nav-toggle" type="button" data-nav-toggle aria-expanded="true" aria-controls="sidebar-scroll">Hide</button>
        </div>
        <div class="theme-switch" role="group" aria-label="Theme">
          <button type="button" data-theme-set="light" aria-pressed="true">Light</button>
          <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
          <button type="button" data-theme-set="evil" aria-pressed="false">Evil</button>
        </div>
      </div>
      <div class="sidebar-scroll" id="sidebar-scroll">
        <div class="nav-label">Main menu</div>
        <a class="nav-link" href="/"{' aria-current="page"' if active == 'projects' else ''}>
          <span class="nav-glyph">P</span><span>Projects</span><span class="nav-count">{len(summaries)}</span>
        </a>
        <div class="project-menu-tools">
          <label class="project-search project-search-rail">
            <span class="sr-only">Search projects</span>
            <input type="search" data-project-search placeholder="Search" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <details class="project-menu" data-project-menu open>
          <summary class="project-menu-summary">
            <span>Project selection</span>
            <span class="nav-count">{len(summaries)}</span>
          </summary>
          <div class="project-menu-list">{''.join(project_links)}</div>
        </details>
        {section_links}
      </div>
      <div class="sidebar-foot"><a href="/setup">Local setup</a><span>Runs on this machine</span></div>
    </aside>
    <main class="main" id="content" tabindex="-1"><div class="content">{mobile_context}{body}</div></main>
  </div>
</body>
</html>"""

    def setup_notice(self) -> str:
        if not self.settings:
            return '<p class="setup-notice"><a href="/setup">Local setup</a></p>'
        local_count = sum(project.kind == "workspace" for project in self.projects.values())
        if not local_count:
            return '<section class="setup-notice"><h2>Set up this machine</h2><p>Choose a projects folder, then open a project to see its agents and conversations. Coordinator and AgentBus history are optional.</p><a class="btn" href="/setup">Choose projects folder</a></section>'
        return '<p class="setup-notice">Open a project to see agents and conversations. <a href="/setup">Local setup &amp; connections</a></p>'

    def setup_page(self, query: dict[str, list[str]], values: dict[str, str] | None = None, error: str = "") -> str:
        settings = self.settings
        if settings is None:
            return self.shell("Local setup", '<h1>Local setup</h1><p>Start the dashboard with scripts/run_dashboard.sh.</p>')
        values = values or {}
        saved = read_config(settings.config)
        fields = []
        for key, (label, helper) in CONFIG_FIELDS.items():
            target = getattr(settings, key)
            explicit = key in saved or "AGENT_DASHBOARD_" + key.upper() in os.environ or any(arg.startswith("--" + key.replace("_", "-")) for arg in settings.launch_argv)
            value = values.get(key, str(target) if target is not None and (target.exists() or explicit) else "")
            fields.append(f'<label class="setup-field" for="setup-{key}"><span>{esc(label)}</span><input id="setup-{key}" aria-label="{esc(label)}" name="{key}" value="{esc(value)}" placeholder="Not configured" spellcheck="false"><small>{esc(helper)}</small></label>')
        roots = values.get("projects_root", "\n".join(str(root) for root in settings.projects_root))
        statuses = []
        for key, name in (("coordinator_db", "Coordinator"), ("agent_bus_db", "AgentBus history")):
            project = self.projects.get("coordinator" if key == "coordinator_db" else "liminal")
            summary = project.summary() if project else None
            state = "Connected" if summary and summary["available"] else "Cannot read source" if summary else "File unavailable — review path below" if saved.get(key) and getattr(settings, key) else "Not configured"
            statuses.append(f'<li><strong>{name}</strong><span>{state}</span></li>')
        probe = ProjectSource("setup", "Setup", "Setup", "", "", "workspace", bus_url=settings.live_bus_url)
        snapshot = probe._live_snapshot()
        reachable = snapshot.get("_reachable", True) is not False
        statuses.append(f'<li><strong>Live broker</strong><span>{"Connected" if reachable else "Disconnected — start your existing AgentBus broker"}</span></li>')
        notice = f'<p class="flash flash-error" role="alert">{esc(error)}</p>' if error else '<p class="flash" role="status">Setup saved. Open a project to continue.</p>' if query.get("saved") else ""
        return self.shell("Local setup", f'''
          <header class="page-head"><div><h1>Local setup</h1><p class="page-copy">Point this dashboard at your projects and existing services. Everything stays on this machine.</p></div><a class="text-link" href="/">Open projects →</a></header>
          {notice}
          <section class="connection-status" aria-label="Connection status"><h2>Connections</h2><ul>{''.join(statuses)}</ul><p>Dashboard running. Connected sources can be read; no agents are started here.</p></section>
          <form class="setup-form" method="post" action="/setup">
            <input type="hidden" name="csrf" value="{esc(self.csrf_token)}">
            <label class="setup-field" for="projects-root"><span>Projects folder</span><textarea id="projects-root" aria-label="Projects folder" name="projects_root" rows="2" required spellcheck="false" aria-describedby="roots-help">{esc(roots)}</textarea><small id="roots-help">Use ~/Projects or an existing absolute folder path. One root per line. Immediate folders and nested repositories appear in the register.</small></label>
            <label class="setup-field" for="broker-url"><span>Live AgentBus broker</span><input id="broker-url" aria-label="Live AgentBus broker" name="live_bus_url" value="{esc(values.get('live_bus_url', settings.live_bus_url))}" required spellcheck="false"><small>Default: http://127.0.0.1:7717. Agents belong to a project when their workdir matches its folder exactly.</small></label>
            <details class="setup-sources"><summary>Optional sources and agent controls</summary><p>Use paths from your existing installations. Leave unused sources blank. This dashboard does not install or start coordination services.</p>{''.join(fields)}</details>
            <div class="setup-save"><button class="btn" type="submit">Save local setup</button><span>Applies immediately; no supervisor restart.</span></div>
          </form>
          <p class="config-location">Saved in <code>{esc(settings.config)}</code>. Command-line flags override environment variables, which override this file. Edit those overrides at launch if a saved value does not change.</p>
          <section class="setup-next"><h2>Next: open a project</h2><p>Use <a href="/">Projects</a> to choose a folder, then Agents to check attached identities and usage. Conversations contains Inbox, Archived, and Trash; restoring a conversation returns it to Inbox without changing source history.</p></section>
        ''')

    def home(self, query: dict[str, list[str]] | None = None) -> str:
        body = f"""
          {self.flash(query or {})}
          <header class="page-head home-head"><div><p class="eyeline">Main menu</p><h1>Choose a project</h1><p class="page-copy">Search the local folders and coordination sources. Pin the ones you keep opening.</p></div></header>
          {self.setup_notice()}
          {self.render_project_register()}
          <figure class="home-cat">
            <img class="home-cat-plain" src="/assets/home-cat.jpg" alt="A long-haired grey tabby cat sitting on a kitchen counter">
            <img class="home-cat-evil" src="/assets/home-cat-evil.jpg?v=cape" alt="The same cat with MS Paint horns, a cape, a pitchfork, and a dead mouse">
          </figure>
        """
        return self.shell("Projects", body)

    def project_page(self, project: ProjectSource) -> str:
        summary = project.summary()
        if not summary["available"]:
            return self.error_page(project, summary["error"])
        recent = [
            conversation
            for conversation in group_conversations(project.messages())
            if self.state_store.status(project.key, conversation["id"]) == "inbox"
        ][:5]
        recent_rows = self.render_conversation_teasers(project, recent)
        body = f"""
          <header class="page-head"><div><p class="eyeline">Project</p><h1>{esc(project.name)}</h1><p class="page-copy">{esc(project.description)}</p></div><div class="path-chip">{esc(project.path_label)}</div></header>
          <section class="view-grid" aria-labelledby="choose-view-title">
            <h2 id="choose-view-title" class="sr-only">Choose a view</h2>
            <a class="view-card" href="/project/{esc(project.key)}/agents"><span class="view-index">01</span><h2>Agents</h2><p>See live status and start or stop attached supervisors.</p><span class="arrow">→</span></a>
            <a class="view-card" href="/project/{esc(project.key)}/messages"><span class="view-index">02</span><h2>Conversations</h2><p>Read, archive, trash, restore, and compose project messages.</p><span class="arrow">→</span></a>
          </section>
          <section class="panel" aria-labelledby="recent-title"><div class="panel-head"><h2 id="recent-title">Recent conversations</h2><a class="text-link" href="/project/{esc(project.key)}/messages">View all →</a></div>{recent_rows}</section>
        """
        return self.shell(project.name, body, project.key, "project")

    def render_agent_rows(self, project: ProjectSource, agents: list[dict[str, Any]], include_usage: bool) -> str:
        rows = []
        for agent in agents:
            filter_text = clean_text(
                " ".join(
                    str(agent.get(key, ""))
                    for key in ("id", "name", "role", "model", "status", "doing", "auth", "role_effect_label", "session_id")
                )
            ).lower()
            actions = []
            if project.kind == "workspace" and agent.get("session_available"):
                actions.append(f"""<form class="inline-form" method="post" action="/project/{esc(project.key)}/agents/open-session">
                  <input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><input type="hidden" name="agent_id" value="{esc(agent.get('id'))}"><button class="btn btn-small" type="submit">{esc(agent.get('session_label') or 'Open latest session')}</button></form>""")
            if project.kind == "workspace" and agent.get("controllable"):
                actions.append(f"""<form class="inline-form" method="post" action="/project/{esc(project.key)}/agents/stop" data-confirm="Stop {esc(agent.get('id'))} and its running child process?">
                  <input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><input type="hidden" name="agent_id" value="{esc(agent.get('id'))}"><button class="btn btn-danger btn-small" type="submit">Stop</button></form>""")
            action = f'<div class="control-stack">{"".join(actions)}</div>' if actions else "—"
            usage_cell = ""
            row_attrs = ""
            if project.kind == "workspace" and agent.get("listed") == "live":
                control_signature = f"{int(bool(agent.get('session_available')))}|{int(bool(agent.get('controllable')))}"
                row_attrs = f' data-agent-id="{esc(agent.get("id"))}" data-agent-control-signature="{control_signature}"'
            if include_usage:
                usage = usage_values(agent.get("usage"))
                usage_cell = f"""<td data-label="Usage"><div class="agent-usage">
                  <strong data-agent-usage="tokens">{format_count(usage['tokens'])} tokens</strong>
                  <span data-agent-usage="turns">{format_count(usage['turns'])} turns</span>
                  <span data-agent-usage="cost">{format_cost(usage['costUSD'])} equivalent</span>
                  <small>{esc(agent.get('auth') or 'Unknown subscription')}</small>
                </div></td>"""
            role_subject = "session" if agent.get("listed") == "session" else "agent"
            role_id = str(agent.get("session_id") or agent.get("id") or "") if role_subject == "session" else str(agent.get("id") or "")
            role_control = self.render_role_control(
                project,
                role_subject,
                role_id,
                clean_text(agent.get("role")),
                str(agent.get("role_effect") or "metadata"),
                str(agent.get("role_effect_label") or "Operator metadata"),
                suffix=str(agent.get("listed") or "row"),
            )
            session_note = ""
            session_id = clean_text(agent.get("session_id"))
            if session_id:
                session_note = f'<div class="mono quiet">session {esc(session_id)}</div>'
            rows.append(
                f"""<tr data-filter-text="{esc(filter_text)}"{row_attrs}><td data-label="Agent"><strong>{esc(agent.get('name'))}</strong><div class="mono quiet">{esc(agent.get('id'))}</div>{session_note}</td>
                <td data-label="Status"><span class="status status-{esc(agent.get('status') or 'unknown')}">{esc(agent.get('status') or 'unknown')}</span></td>
                <td data-label="Role"><div class="role-cell">{role_control}<div class="mono quiet">{esc(agent.get('model') or '')}</div></div></td>
                <td data-label="Current">{esc(agent.get('doing') or 'No activity reported')}</td>{usage_cell}<td data-label="Active" class="mono muted">{esc(display_time(agent.get('last_active')))}</td><td data-label="Control">{action}</td></tr>"""
            )
        usage_heading = "<th>Usage</th>" if include_usage else ""
        return f'<div class="table-wrap"><table class="data-table"><thead><tr><th>Agent</th><th>Status</th><th>Role / model</th><th>Current context</th>{usage_heading}<th>Last active</th><th>Control</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>'

    def agents_page(self, project: ProjectSource, query: dict[str, list[str]] | None = None) -> str:
        query = query or {}
        live_snapshot: dict[str, Any] | None = None
        try:
            if project.kind == "workspace":
                live_snapshot = project._live_snapshot()
                agents = self.apply_saved_agent_roles(project, project.listed_agents(live_snapshot))
            else:
                agents = self.apply_saved_agent_roles(project, project.listed_agents())
        except (OSError, sqlite3.Error, ValueError) as error:
            return self.error_page(project, str(error), "agents")
        flash = self.flash(query)
        session_agents = self.session_assignment_rows(project, agents)
        live_agents = [agent for agent in agents if agent.get("listed") not in {"registered", "session"}]
        registered_agents = [agent for agent in agents if agent.get("listed") == "registered"]
        include_usage = project.kind == "workspace"
        if live_agents:
            live_table = self.render_agent_rows(project, live_agents, include_usage)
        else:
            live_table = '<div class="empty"><h2>No agents attached</h2><p>Connect an existing AgentBus supervisor using this project’s exact folder as its workdir. Registered supervisors appear below when configured. <a href="/setup">Check local setup</a>.</p></div>'
        registered_section = ""
        if registered_agents:
            registered_table = self.render_agent_rows(project, registered_agents, include_usage=False)
            registered_section = f'<section class="panel" aria-label="Registered AgentBus agents"><div class="panel-head"><h2>Registered AgentBus agents</h2><span class="panel-meta">{len(registered_agents)} identities</span></div>{registered_table}</section>'
        session_section = ""
        if session_agents:
            session_table = self.render_agent_rows(project, session_agents, include_usage=False)
            session_section = f'<section class="panel" aria-label="Session assignments"><div class="panel-head"><h2>Assigned by session</h2><span class="panel-meta">{len(session_agents)} session ids</span></div>{session_table}</section>'
        bindable = [agent for agent in agents if agent.get("id")]
        bind_options = ''.join(
            f'<option value="{esc(item.get("id"))}">{esc(item.get("id"))}</option>' for item in bindable
        )
        session_form = f"""
          <details class="session-assign" aria-labelledby="session-assign-title">
            <summary id="session-assign-title">Assign a role by session ID</summary><div><p>Paste a Claude or Codex session id, optionally bind it to an agent in this project, then save the role.</p></div>
            <form class="session-assign-form" method="post" action="/project/{esc(project.key)}/agents/set-role">
              <input type="hidden" name="csrf" value="{esc(self.csrf_token)}">
              <div class="session-assign-fields">
                <label for="session-id-input">Session ID<input id="session-id-input" name="session_id" value="" maxlength="{MAX_SESSION_LENGTH}" autocomplete="off" required placeholder="Paste a Claude or Codex session ID"></label>
                <label for="session-agent-input">Agent<select id="session-agent-input" name="agent_id"><option value="">None · session only</option>{bind_options}</select></label>
                <label for="session-role-input">Role<input id="session-role-input" name="role" list="role-presets" maxlength="{MAX_ROLE_LENGTH}" autocomplete="off" required placeholder="Independent QA"></label>
                <button class="btn btn-primary" type="submit">Save</button>
              </div>
            </form>
          </details>
        """
        controls = ""
        usage_monitor = ""
        if project.kind == "workspace":
            active_ids = project.attached_agent_ids()
            definitions = [item for item in project.agent_definitions() if item["id"] not in active_ids]
            options = ''.join(f'<option value="{esc(item["id"])}">{esc(item["id"])} · {esc(item["model"] or item["harness"])}</option>' for item in definitions)
            reachable = live_snapshot is None or live_snapshot.get("_reachable", True) is not False
            select_disabled = "" if options and reachable else " disabled"
            controllable_count = sum(1 for agent in live_agents if agent.get("controllable"))
            stop_disabled = "" if controllable_count and reachable else " disabled"
            controls = f"""
              <section class="control-strip" aria-labelledby="control-title"><div><p class="eyeline">Agent controls</p><h2 id="control-title">Run this project</h2><p>Starts an existing AgentBus supervisor in this repository. Stop sends a graceful termination request to that supervisor.</p></div>
                <div class="control-actions"><form class="agent-control-form" method="post" action="/project/{esc(project.key)}/agents/start"><input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><label for="agent-id">Registered agent</label><div class="field-row"><select id="agent-id" name="agent_id" required{select_disabled}><option value="" selected disabled>{'Choose an agent…' if options else 'No registered agents available — check Local setup'}</option>{options}</select><button class="btn btn-primary" type="submit"{select_disabled}>Start agent</button></div></form>
                <form class="inline-form" method="post" action="/project/{esc(project.key)}/agents/stop-all" data-confirm="Stop all {controllable_count} controllable supervisors in this project?"><input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><button class="btn btn-danger" type="submit"{stop_disabled}>Stop all</button></form></div></section>
            """
            live_reachable = live_snapshot is None or live_snapshot.get("_reachable", True) is not False
            last_observed = "" if live_snapshot is None else clean_text(live_snapshot.get("_observedAt"))
            usage_monitor = self.render_usage_monitor(project, live_agents, live_reachable, last_observed)
        body = f"""
          <header class="page-head"><div><p class="eyeline">{esc(project.short_name)}</p><h1>Agents</h1><p class="page-copy">Check attached agents, their current activity, and saved roles. Usage and controls are available for live AgentBus workspaces.</p></div><a class="text-link" href="/project/{esc(project.key)}/messages">Conversations →</a></header>
          {flash}{controls}
          {usage_monitor}
          {self.role_presets_datalist()}
          <div class="toolbar"><div class="search"><input data-search type="search" aria-label="Filter agents" placeholder="Search agents"></div><a class="btn btn-quiet" href="/project/{esc(project.key)}/agents">Refresh</a></div>
          <section class="panel" aria-label="Agent list"><div class="panel-head"><h2>Attached agents</h2><span class="panel-meta">{len(live_agents)} observed</span></div>{live_table}</section>
          {registered_section}
          {session_section}
          {session_form}
        """
        return self.shell(f"{project.name} agents", body, project.key, "agents")

    def render_usage_monitor(
        self,
        project: ProjectSource,
        agents: list[dict[str, Any]],
        reachable: bool = True,
        last_observed: str = "",
    ) -> str:
        summary = summarize_usage(agents)
        total = summary["total"]
        subscription_rows = []
        for group in summary["subscriptions"]:
            subscription_rows.append(
                f"""<div class="usage-subscription">
                  <div><strong>{esc(group['name'])}</strong><span>{esc(', '.join(group['agents']))}</span></div>
                  <span>{format_count(group['turns'])} turns</span><span>{format_count(group['tokens'])} tokens</span><span>{format_cost(group['costUSD'])} equivalent</span>
                </div>"""
            )
        if not subscription_rows:
            subscription_rows.append('<div class="usage-empty">Usage appears after an attached agent completes a turn.</div>')
        if reachable:
            monitor_status = "Updates every 10s"
        elif last_observed:
            monitor_status = f"Update paused · last confirmed {display_time(last_observed)}"
        else:
            monitor_status = "Broker unavailable · retrying"
        return f"""
          <section class="panel usage-panel" aria-labelledby="usage-title" data-usage-monitor data-api-url="/project/{esc(project.key)}/api/agents">
            <div class="panel-head"><div><h2 id="usage-title">Usage monitor</h2><p>Current broker session · resets when AgentBus restarts</p></div><span class="panel-meta" data-usage-status aria-live="polite">{esc(monitor_status)}</span></div>
            <div class="usage-totals">
              <div><span>Turns</span><strong data-usage-total="turns">{format_count(total['turns'])}</strong></div>
              <div><span>Tokens</span><strong data-usage-total="tokens">{format_count(total['tokens'])}</strong></div>
              <div><span>Equivalent cost</span><strong data-usage-total="cost">{format_cost(total['costUSD'])}</strong><small>Estimate, not a subscription charge</small></div>
            </div>
            <div class="usage-breakdown"><div class="usage-breakdown-head"><span>Subscription / harness</span><span>Turns</span><span>Tokens</span><span>Equivalent cost</span></div><div data-usage-subscriptions>{''.join(subscription_rows)}</div></div>
          </section>
        """

    def messages_page(self, project: ProjectSource, query: dict[str, list[str]]) -> str:
        try:
            messages = project.messages()
            agents = project.agents()
        except (OSError, sqlite3.Error, ValueError) as error:
            return self.error_page(project, str(error), "messages")
        conversations = group_conversations(messages)
        for conversation in conversations:
            conversation["status"] = self.state_store.status(project.key, conversation["id"])
        counts = {box: sum(1 for item in conversations if item["status"] == box) for box in ("inbox", "archived", "trash")}
        box = (query.get("box") or ["inbox"])[0]
        if box not in counts:
            box = "inbox"
        filtered = [item for item in conversations if item["status"] == box]
        search_query = clean_text((query.get("q") or [""])[0])[:160]
        if search_query:
            needle = search_query.lower()
            filtered = [
                item
                for item in filtered
                if needle
                in clean_text(
                    " ".join(
                        [item["title"], " ".join(item["participants"]), item["latest_body"]]
                        + [
                            f"{message.get('subject', '')} {message.get('body', '')} {message.get('sender', '')} {message.get('recipient', '')}"
                            for message in item["messages"]
                        ]
                    )
                ).lower()
            ]
        try:
            page = max(1, int((query.get("page") or ["1"])[0]))
        except ValueError:
            page = 1
        selected_id = (query.get("conversation") or [""])[0]
        if selected_id:
            selected_index = next((index for index, item in enumerate(filtered) if item["id"] == selected_id), None)
            if selected_index is not None:
                page = selected_index // CONVERSATIONS_PER_PAGE + 1
        page_count = max(1, (len(filtered) + CONVERSATIONS_PER_PAGE - 1) // CONVERSATIONS_PER_PAGE)
        page = min(page, page_count)
        start = (page - 1) * CONVERSATIONS_PER_PAGE
        visible = filtered[start : start + CONVERSATIONS_PER_PAGE]
        selected = next((item for item in visible if item["id"] == selected_id), visible[0] if visible else None)
        tabs_list = []
        for name, label in (("inbox", "Inbox"), ("archived", "Archived"), ("trash", "Trash")):
            current = ' aria-current="page"' if box == name else ""
            tabs_list.append(
                f'<a class="conversation-tab" href="/project/{esc(project.key)}/messages?box={name}"{current}>{label}<span>{counts[name]}</span></a>'
            )
        tabs = "".join(tabs_list)
        list_html = self.render_conversation_list(project, visible, box, selected["id"] if selected else "", page, search_query)
        detail_html = self.render_conversation_detail(project, selected, box)
        pagination = self.render_pagination(project, box, page, page_count, search_query)
        compose = self.render_compose(project, agents)
        body = f"""
          <header class="page-head conversation-head"><div><p class="eyeline">{esc(project.short_name)}</p><h1>Conversations</h1><p class="page-copy">{len(messages)} messages grouped into {len(conversations)} conversations. Archive and Trash only change this dashboard; source history stays intact. Conversation roles are operator metadata only.</p></div><a class="text-link" href="/project/{esc(project.key)}/agents">Manage agents →</a></header>
          {self.flash(query)}
          {self.role_presets_datalist()}
          <nav class="conversation-tabs" aria-label="Conversation folders">{tabs}</nav>
          <section class="conversation-workspace" aria-label="{esc(box.title())} conversations">
            <aside class="conversation-index"><form class="conversation-tools" method="get" action="/project/{esc(project.key)}/messages"><input type="hidden" name="box" value="{esc(box)}"><div class="search"><input data-search name="q" value="{esc(search_query)}" type="search" aria-label="Search all conversations" placeholder="Search all conversations"></div><button class="btn btn-small" type="submit">Search</button><span>{len(filtered)} found</span></form>{list_html}{pagination}</aside>
            <article class="conversation-detail" id="conversation-detail" tabindex="-1">{detail_html}</article>
          </section>
          {compose}
        """
        return self.shell(f"{project.name} conversations", body, project.key, "messages")

    def render_conversation_list(self, project: ProjectSource, conversations: list[dict[str, Any]], box: str, selected_id: str, page: int, search_query: str) -> str:
        if not conversations:
            return f'<div class="empty compact-empty"><h2>{esc(box.title())} is empty</h2><p>{"Archived conversations appear here." if box == "archived" else "Deleted conversations stay here until you restore them." if box == "trash" else "Messages appear when agents are attached to this project’s exact folder. Check Agents or Local setup to connect your existing services."}</p></div>'
        rows = []
        for conversation in conversations:
            actions = self.conversation_actions(project, conversation["id"], box, compact=True)
            participants = ", ".join(conversation["participants"])
            filter_text = clean_text(f"{conversation['title']} {participants} {conversation['latest_body']}").lower()
            selected_class = " selected" if conversation["id"] == selected_id else ""
            link_query = urllib.parse.urlencode(
                {
                    "box": box,
                    "page": page,
                    "conversation": conversation["id"],
                    **({"q": search_query} if search_query else {}),
                }
            )
            record = self.state_store.role_record(project.key, conversation["id"])
            conversation_role = (record or {}).get("role") or ""
            role_control = self.render_role_control(
                project,
                "conversation",
                conversation["id"],
                conversation_role,
                "metadata",
                "Operator metadata",
                suffix="list",
                box=box,
            )
            role_note = f'<span class="conversation-role-label">{esc(conversation_role)}</span>' if conversation_role else ""
            rows.append(f"""
              <div class="conversation-row{selected_class}" data-filter-text="{esc(filter_text + ' ' + conversation_role)}">
                <a class="conversation-link" href="/project/{esc(project.key)}/messages?{esc(link_query)}#conversation-detail"><span class="conversation-row-top"><strong>{esc(conversation['title'])}</strong><time>{esc(conversation.get('latest_display', ''))}</time></span><span class="conversation-route">{esc(participants)}</span><span class="conversation-preview">{esc(conversation['latest_body'])}</span><span class="conversation-meta">{conversation['message_count']} message{'s' if conversation['message_count'] != 1 else ''}{role_note}</span></a>
                <div class="conversation-foot">
                  <details class="conversation-role role-editor"><summary>{esc(conversation_role) if conversation_role else "Add role"}</summary>{role_control}</details>
                  <div class="conversation-actions">{actions}</div>
                </div>
              </div>""")
        return f'<div class="conversation-list">{"".join(rows)}</div>'

    def render_conversation_detail(self, project: ProjectSource, conversation: dict[str, Any] | None, box: str) -> str:
        if conversation is None:
            return '<div class="empty detail-empty"><span class="empty-mark" aria-hidden="true"><img src="/assets/b-logo.png?v=cat" alt=""></span><h2>No conversation selected</h2><p>Choose a conversation from the list.</p></div>'
        transcript = []
        for message in conversation["messages"]:
            recipient = message.get("recipient") or "all"
            transcript.append(f"""
              <section class="transcript-item"><header><span class="speaker-mark">{esc((clean_text(message.get('sender')) or '?')[:1].upper())}</span><div><strong>{esc(message.get('sender') or 'unknown')}</strong><span>to {esc(recipient)}</span></div><time>{esc(display_time(message.get('ts')))}</time></header><div class="transcript-subject">{esc(message.get('subject') or '(no subject)')}</div><div class="transcript-body">{esc(message.get('body') or '')}</div></section>""")
        participants = ", ".join(conversation["participants"])
        record = self.state_store.role_record(project.key, conversation["id"])
        conversation_role = (record or {}).get("role") or ""
        role_control = self.render_role_control(
            project,
            "conversation",
            conversation["id"],
            conversation_role,
            "metadata",
            "Operator metadata",
            suffix="detail",
            box=box,
        )
        return f"""
          <header class="detail-head"><div><p class="eyeline">{esc(conversation.get('thread') or 'Conversation')}</p><h2>{esc(conversation['title'])}</h2><p>{esc(participants)} · {conversation['message_count']} message{'s' if conversation['message_count'] != 1 else ''}</p></div><div class="detail-actions">{self.conversation_actions(project, conversation['id'], box)}</div></header>
          <div class="conversation-role detail-role">{role_control}</div>
          <div class="transcript">{''.join(transcript)}</div>
        """

    def conversation_actions(self, project: ProjectSource, conversation_id: str, box: str, compact: bool = False) -> str:
        button_class = "icon-action" if compact else "btn btn-quiet"
        if box == "inbox":
            actions = (("archive", "Archive", ""), ("delete", "Move to Trash", ""))
        elif box == "archived":
            actions = (("restore", "Restore", ""), ("delete", "Move to Trash", ""))
        else:
            actions = (("restore", "Restore", ""),)
        forms = []
        for action, label, confirm in actions:
            confirm_attr = f' data-confirm="{esc(confirm)}"' if confirm else ""
            danger_class = " danger-text" if action == "delete" else ""
            forms.append(f'<form class="inline-form" method="post" action="/project/{esc(project.key)}/conversations/{action}"{confirm_attr}><input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><input type="hidden" name="conversation_id" value="{esc(conversation_id)}"><button class="{button_class}{danger_class}" type="submit" title="{label}">{label}</button></form>')
        return ''.join(forms)

    def render_pagination(self, project: ProjectSource, box: str, page: int, page_count: int, search_query: str) -> str:
        if page_count <= 1:
            return ""
        def page_url(number: int) -> str:
            query = urllib.parse.urlencode({"box": box, "page": number, **({"q": search_query} if search_query else {})})
            return f"/project/{esc(project.key)}/messages?{esc(query)}"
        previous = f'<a class="btn btn-small" href="{page_url(page - 1)}">← Previous</a>' if page > 1 else '<span></span>'
        following = f'<a class="btn btn-small" href="{page_url(page + 1)}">Next →</a>' if page < page_count else '<span></span>'
        return f'<nav class="pagination" aria-label="Conversation pages">{previous}<span>{page} / {page_count}</span>{following}</nav>'

    def render_compose(self, project: ProjectSource, agents: list[dict[str, Any]]) -> str:
        recipient_options = ['<option value="" selected disabled>Choose a recipient…</option>']
        if agents or project.kind != "workspace":
            recipient_options.append('<option value="all">All project agents</option>')
        recipient_options.extend(f'<option value="{esc(agent.get("id"))}">{esc(agent.get("name") or agent.get("id"))}</option>' for agent in agents)
        can_send = project.kind != "workspace" or bool(agents)
        disabled = "" if can_send else " disabled"
        note = f"Sends only to agents attached to {project.path_label}." if project.kind == "workspace" else f"Uses the existing {project.short_name} message command."
        return f"""
          <details class="panel compose"><summary class="panel-head"><h2>New message</h2><span class="panel-meta">Compose <span class="compose-caret">›</span></span></summary>
            <form class="compose-form" method="post" action="/project/{esc(project.key)}/messages/send"><input type="hidden" name="csrf" value="{esc(self.csrf_token)}">
              <div class="field"><label for="sender">From</label><input id="sender" name="sender" value="operator" readonly required maxlength="80"></div><div class="field"><label for="recipient">To</label><select id="recipient" name="recipient" required{disabled}>{''.join(recipient_options)}</select></div>
              <div class="field"><label for="subject">Subject</label><input id="subject" name="subject" maxlength="160" placeholder="Optional"{disabled}></div><div class="field"><label for="thread">Thread</label><input id="thread" name="thread" maxlength="120" placeholder="Optional topic"{disabled}></div>
              <div class="field field-wide"><label for="body">Message</label><textarea id="body" name="body" required maxlength="12000" placeholder="Write a message"{disabled}></textarea></div><div class="form-actions"><span class="form-note">{esc(note)}</span><button class="btn btn-primary" type="submit"{disabled}>Send message</button></div>
            </form>
          </details>"""

    def render_conversation_teasers(self, project: ProjectSource, conversations: list[dict[str, Any]]) -> str:
        if not conversations:
            return '<div class="empty"><h2>No conversations yet</h2><p>Messages appear when agents are attached to this project’s exact folder. Open Agents to check the roster, or <a href="/setup">check local setup</a>.</p></div>'
        rows = []
        for conversation in conversations:
            rows.append(f'<a class="teaser-row" href="/project/{esc(project.key)}/messages?conversation={esc(conversation["id"])}"><span><strong>{esc(conversation["title"])}</strong><small>{esc(", ".join(conversation["participants"]))}</small></span><span class="teaser-preview">{esc(conversation["latest_body"])}</span><time>{esc(conversation.get("latest_display", ""))}</time><span class="arrow">→</span></a>')
        return f'<div class="teaser-list">{"".join(rows)}</div>'

    @staticmethod
    def flash(query: dict[str, list[str]]) -> str:
        if "error" in query:
            return f'<div class="flash flash-error" role="alert">{esc(query["error"][0])}</div>'
        messages = {
            "sent": "Message sent through the existing project bus.",
            "archived": "Conversation archived.",
            "trashed": "Conversation moved to Trash.",
            "restored": "Conversation restored to Inbox.",
            "started": "Agent supervisor started.",
            "stopped": "Agent supervisor stopped.",
            "stopped-all": "All controllable supervisors stopped.",
            "session-opened": "Agent session opened in Terminal.",
            "role-saved": "Role saved.",
            "role-reset": "Role reset to the original default.",
        }
        action = (query.get("action") or [""])[0]
        if query.get("sent") == ["1"]:
            action = "sent"
        return f'<div class="flash flash-success" role="status">{messages[action]}</div>' if action in messages else ""

    def error_page(self, project: ProjectSource, error: str, active: str = "project") -> str:
        body = f'<header class="page-head"><div><p class="eyeline">{esc(project.short_name)}</p><h1>Source unavailable</h1><p class="page-copy">This project could not be read. No other project data was substituted.</p></div></header><section class="panel error-panel"><div class="panel-head"><h2>Check this source</h2></div><div class="error-copy">{esc(error)}<p><a href="/setup">Open local setup</a> to review the path and connection.</p></div></section>'
        return self.shell("Source unavailable", body, project.key, active)

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "service": "agent-bus-dashboard", "time": datetime.now(timezone.utc).isoformat(), "projects": self.summaries()}


class Handler(BaseHTTPRequestHandler):
    dashboard: Dashboard

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        try:
            if path == "/":
                self.send_html(self.dashboard.home(urllib.parse.parse_qs(parsed.query)))
                return
            if path == "/setup":
                self.send_html(self.dashboard.setup_page(urllib.parse.parse_qs(parsed.query)))
                return
            if path == "/health":
                self.send_json(self.dashboard.health())
                return
            if path == "/api/projects":
                self.send_json({"projects": self.dashboard.summaries()})
                return
            if path.startswith("/assets/"):
                self.send_asset(path.removeprefix("/assets/"))
                return
            parts = [part for part in path.split("/") if part]
            if len(parts) >= 2 and parts[0] == "project":
                project = self.dashboard.project(parts[1])
                if len(parts) == 2:
                    self.send_html(self.dashboard.project_page(project))
                    return
                if len(parts) == 3 and parts[2] == "agents":
                    query = urllib.parse.parse_qs(parsed.query)
                    self.send_html(self.dashboard.agents_page(project, query))
                    return
                if len(parts) == 3 and parts[2] == "messages":
                    query = urllib.parse.parse_qs(parsed.query)
                    self.send_html(self.dashboard.messages_page(project, query))
                    return
                if len(parts) == 4 and parts[2] == "api" and parts[3] == "agents":
                    if project.kind == "workspace":
                        snapshot = project._live_snapshot()
                        agents = project._workspace_agents(snapshot)
                        payload = {
                            "project": project.key,
                            "agents": agents,
                            "usage": summarize_usage(agents),
                            "lastObserved": snapshot.get("_observedAt") or "",
                        }
                        if snapshot.get("_reachable", True) is False:
                            payload["error"] = "AgentBus broker unavailable"
                            self.send_json(payload, HTTPStatus.SERVICE_UNAVAILABLE)
                            return
                    else:
                        agents = project.agents()
                        payload = {"project": project.key, "agents": agents, "usage": summarize_usage(agents)}
                    self.send_json(payload)
                    return
                if len(parts) == 4 and parts[2] == "api" and parts[3] == "messages":
                    self.send_json({"project": project.key, "messages": project.messages()})
                    return
            self.send_error_page(HTTPStatus.NOT_FOUND, "Page not found")
        except KeyError:
            self.send_error_page(HTTPStatus.NOT_FOUND, "Unknown project")
        except (OSError, sqlite3.Error, ValueError) as error:
            self.send_error_page(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")
        parts = [part for part in path.split("/") if part]
        if path == "/setup":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16000:
                    raise ValueError("Invalid form size. Reload setup and try again.")
                form = {key: values[0] for key, values in urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True).items()}
                if not secrets.compare_digest(form.get("csrf", ""), self.dashboard.csrf_token):
                    self.send_error_page(HTTPStatus.FORBIDDEN, "The form expired. Reload setup and try again.")
                    return
                settings = self.dashboard.settings
                if settings is None:
                    raise ValueError("Setup is unavailable in this test instance.")
                settings = save_setup(settings, form)
                self.dashboard.projects = {project.key: project for project in make_projects(settings)}
                self.dashboard.settings = settings
                self.redirect("/setup?saved=1")
            except (OSError, ValueError) as error:
                self.send_html(self.dashboard.setup_page({}, locals().get("form", {}), str(error)))
            return
        if len(parts) != 4 or parts[0] != "project":
            self.send_error_page(HTTPStatus.NOT_FOUND, "Action not found")
            return
        try:
            project = self.dashboard.project(parts[1])
        except KeyError:
            self.send_error_page(HTTPStatus.NOT_FOUND, "Unknown project")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 16000:
            if parts[2] == "flags":
                self.redirect("/?error=" + urllib.parse.quote("Invalid form payload"))
                return
            self.redirect(self.action_error_location(project, parts[2], "Invalid form payload"))
            return
        payload = self.rfile.read(length).decode("utf-8", errors="replace")
        form = {key: values[0] for key, values in urllib.parse.parse_qs(payload, keep_blank_values=True).items()}
        if not secrets.compare_digest(form.get("csrf", ""), self.dashboard.csrf_token):
            if parts[2] == "flags":
                self.redirect("/?error=" + urllib.parse.quote("The form expired. Refresh and try again."))
                return
            self.redirect(self.action_error_location(project, parts[2], "The form expired. Refresh and try again."))
            return
        if parts[2] == "flags" and parts[3] in {"pin", "unpin"}:
            self.pin_action(project, parts[3])
            return
        if parts[2:] == ["messages", "send"]:
            self.send_message_action(project, form)
            return
        if parts[2] == "conversations" and parts[3] in {"archive", "delete", "restore"}:
            self.conversation_action(project, parts[3], form)
            return
        if parts[2] == "agents" and parts[3] in {"start", "stop", "stop-all", "open-session"}:
            self.agent_action(project, parts[3], form)
            return
        if parts[2] in {"agents", "conversations"} and parts[3] in {"set-role", "reset-role"}:
            self.role_action(project, parts[2], parts[3], form)
            return
        self.send_error_page(HTTPStatus.NOT_FOUND, "Action not found")

    def pin_action(self, project: ProjectSource, action: str) -> None:
        try:
            self.dashboard.state_store.set_pinned(project.key, action == "pin")
        except (OSError, ValueError) as error:
            self.redirect("/?error=" + urllib.parse.quote(str(error)))
            return
        self.redirect(self.safe_return_path())

    def safe_return_path(self) -> str:
        referer = self.headers.get("Referer", "")
        parsed = urllib.parse.urlparse(referer)
        if parsed.hostname in {None, "127.0.0.1", "localhost"} and parsed.path.startswith("/"):
            path = parsed.path
            if parsed.query:
                return f"{path}?{parsed.query}"
            return path
        return "/"

    def send_message_action(self, project: ProjectSource, form: dict[str, str]) -> None:
        sender = clean_text(form.get("sender"))[:80]
        recipient = clean_text(form.get("recipient"))[:80]
        subject = clean_text(form.get("subject"))[:160]
        thread = clean_text(form.get("thread"))[:120]
        body = str(form.get("body") or "").strip()[:12000]
        if not sender or not recipient or not body:
            self.redirect(f"/project/{project.key}/messages?error={urllib.parse.quote('Sender, recipient, and message are required.')}")
            return
        try:
            project.send(sender, recipient, subject, thread, body)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self.redirect(f"/project/{project.key}/messages?error={urllib.parse.quote(str(error))}")
            return
        self.redirect(f"/project/{project.key}/messages?sent=1")

    def conversation_action(self, project: ProjectSource, action: str, form: dict[str, str]) -> None:
        conversation_id = clean_text(form.get("conversation_id"))[:80]
        known = {item["id"] for item in group_conversations(project.messages())}
        if conversation_id not in known:
            self.redirect(f"/project/{project.key}/messages?error={urllib.parse.quote('Conversation no longer exists')}")
            return
        status = {"archive": "archived", "delete": "trash", "restore": "inbox"}[action]
        try:
            self.dashboard.state_store.set_status(project.key, conversation_id, status)
        except (OSError, ValueError) as error:
            self.redirect(f"/project/{project.key}/messages?error={urllib.parse.quote(str(error))}")
            return
        outcome = {"archive": "archived", "delete": "trashed", "restore": "restored"}[action]
        box = {"archive": "archived", "delete": "trash", "restore": "inbox"}[action]
        self.redirect(f"/project/{project.key}/messages?box={box}&action={outcome}")

    def agent_action(self, project: ProjectSource, action: str, form: dict[str, str]) -> None:
        agent_id = clean_text(form.get("agent_id"))[:80]
        try:
            if action == "start":
                if not agent_id:
                    raise RuntimeError("Choose an agent to start")
                project.start_agent(agent_id)
                outcome = "started"
            elif action == "stop":
                if not agent_id:
                    raise RuntimeError("Choose an agent to stop")
                project.stop_agent(agent_id)
                outcome = "stopped"
            elif action == "open-session":
                if not agent_id:
                    raise RuntimeError("Choose an agent session to open")
                project.open_session(agent_id)
                outcome = "session-opened"
            else:
                project.stop_all()
                outcome = "stopped-all"
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self.redirect(f"/project/{project.key}/agents?error={urllib.parse.quote(str(error))}")
            return
        self.redirect(f"/project/{project.key}/agents?action={outcome}")

    def role_action(self, project: ProjectSource, section: str, action: str, form: dict[str, str]) -> None:
        target = "agents" if section == "agents" else "messages"
        try:
            if section == "agents":
                if "session_id" in form:
                    if action == "set-role":
                        self.dashboard.assign_session_role(project, form.get("session_id"), form.get("role"), form.get("agent_id"))
                    else:
                        self.dashboard.reset_session_role(project, form.get("session_id"))
                else:
                    agent_id = clean_text(form.get("agent_id"))[:80]
                    if action == "set-role":
                        self.dashboard.assign_agent_role(project, agent_id, form.get("role"))
                    else:
                        self.dashboard.reset_agent_role(project, agent_id)
                self.redirect(f"/project/{project.key}/agents?action={'role-saved' if action == 'set-role' else 'role-reset'}")
                return
            conversation_id = clean_text(form.get("conversation_id"))[:80]
            if action == "set-role":
                self.dashboard.assign_conversation_role(project, conversation_id, form.get("role"))
            else:
                self.dashboard.reset_conversation_role(project, conversation_id)
            box = clean_text(form.get("box"))
            if box not in {"inbox", "archived", "trash"}:
                box = "inbox"
            query = urllib.parse.urlencode(
                {
                    "box": box,
                    "conversation": conversation_id,
                    "action": "role-saved" if action == "set-role" else "role-reset",
                }
            )
            self.redirect(f"/project/{project.key}/messages?{query}")
        except RoleAssignmentError as error:
            self.redirect(self.action_error_location(project, target, str(error)))
        except (OSError, ValueError) as error:
            self.redirect(self.action_error_location(project, target, str(error)))

    @staticmethod
    def action_error_location(project: ProjectSource, section: str, message: str) -> str:
        target = "agents" if section == "agents" else "messages"
        return f"/project/{project.key}/{target}?error={urllib.parse.quote(message)}"

    def send_html(self, content: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = content.encode("utf-8")
        self.send_response(status)
        self.security_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_asset(self, name: str) -> None:
        allowed = {
            "dashboard.css": "text/css; charset=utf-8",
            "dashboard.js": "text/javascript; charset=utf-8",
            "theme.js": "text/javascript; charset=utf-8",
            "b-logo.png": "image/png",
            "home-cat.jpg": "image/jpeg",
            "home-cat-evil.jpg": "image/jpeg",
            "CloisterBlack.ttf": "font/ttf",
        }
        content_type = allowed.get(name)
        if content_type is None:
            self.send_error_page(HTTPStatus.NOT_FOUND, "Asset not found")
            return
        data = (ASSETS / name).read_bytes()
        self.send_response(HTTPStatus.OK)
        self.security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.SEE_OTHER)
        self.security_headers()
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_error_page(self, status: HTTPStatus, message: str) -> None:
        body = f"""
          <header class="page-head"><div><p class="eyeline">Error {int(status)}</p><h1>{esc(message)}</h1><p class="page-copy">Return to the main menu and choose an available project.</p></div></header>
          <a class="btn" href="/">Back to projects</a>
        """
        self.send_html(self.dashboard.shell(str(status.phrase), body), status)

    def security_headers(self) -> None:
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def project_key(path: Path) -> str:
    slug = "".join(character.lower() if character.isalnum() else "-" for character in path.name)
    slug = "-".join(part for part in slug.split("-") if part) or "project"
    digest = hashlib.sha256(str(path.resolve()).encode("utf-8")).hexdigest()[:8]
    return f"repo-{slug[:40]}-{digest}"


def discover_project_paths(roots: list[Path]) -> list[tuple[Path, Path]]:
    discovered: dict[str, tuple[Path, Path]] = {}
    for root in roots:
        if not root.is_dir():
            continue
        try:
            top_level = sorted(
                (path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".")),
                key=lambda path: path.name.lower(),
            )
        except OSError:
            continue
        for path in top_level:
            discovered[str(path.resolve())] = (path.resolve(), root.resolve())
            try:
                nested = sorted(
                    (child for child in path.iterdir() if child.is_dir() and not child.name.startswith(".")),
                    key=lambda child: child.name.lower(),
                )
            except OSError:
                continue
            for child in nested:
                if any((child / marker).exists() for marker in PROJECT_MARKERS):
                    discovered[str(child.resolve())] = (child.resolve(), root.resolve())
    return sorted(discovered.values(), key=lambda item: str(item[0]).lower())


def make_projects(args: argparse.Namespace) -> list[ProjectSource]:
    projects = [
        ProjectSource(
            key="coordinator",
            name="Agent Coordinator",
            short_name="Coordinator",
            description="Full coordination state for agents, tasks, review, and project messages.",
            path_label=str(args.coordinator_db),
            db_path=args.coordinator_db,
            kind="coordinator",
            cli_path=args.coordinator_cli,
        ),
        ProjectSource(
            key="liminal",
            name="AgentBus history",
            short_name="Bus history",
            description="Messages from the optional AgentBus SQLite store.",
            path_label=str(args.agent_bus_db),
            db_path=args.agent_bus_db,
            kind="agent-bus",
            cli_path=args.agent_bus_cli,
            status_dir=args.status_dir,
        ),
    ]
    projects = [project for project in projects if project.db_path and project.db_path.is_file()]
    for path, root in discover_project_paths(args.projects_root):
        try:
            relative = path.relative_to(root)
        except ValueError:
            relative = Path(path.name)
        name = " / ".join(relative.parts)
        projects.append(
            ProjectSource(
                key=project_key(path),
                name=name,
                short_name=path.name,
                description="Local project. Agents and messages appear when an AgentBus supervisor is attached to this workdir.",
                path_label=str(path),
                kind="workspace",
                workspace_path=path,
                bus_url=args.live_bus_url,
                operator_token=args.operator_token,
                audit_log=args.audit_log,
                agent_bus_root=args.agent_bus_root,
            )
        )
    return projects


def _extract_csrf(page: str) -> str:
    match = re.search(r'name="csrf" value="([^"]+)"', page)
    if match is None:
        raise RoleAssignmentError("CSRF token missing from agents page")
    return match.group(1)


def check_role_assignment() -> list[str]:
    failures: list[str] = []
    tmp = Path(tempfile.mkdtemp(prefix="agent-bus-role-check-"))
    server: ThreadingHTTPServer | None = None
    previous_dashboard = getattr(Handler, "dashboard", None)
    try:
        workspace = tmp / "workspace"
        workspace.mkdir()
        root = tmp / "agent-bus"
        root.mkdir()
        registry = {
            "opus": {
                "harness": "claude",
                "cliModel": "claude-opus-5",
                "effort": "high",
                "role": "manager",
                "model": "opus-5",
                "auth": "Claude subscription",
                "description": "Isolated checker manager",
            },
            "gpt": {
                "harness": "codex",
                "role": "worker",
                "model": "gpt-5.6-sol",
                "description": "Isolated checker worker",
            },
        }
        registry_path = root / "agents.json"
        registry_path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
        state_path = tmp / "dashboard-state.json"
        project = ProjectSource(
            key="repo-role-check-aaaaaaaa",
            name="Role Check",
            short_name="RoleCheck",
            description="Isolated role assignment fixture.",
            path_label=str(workspace),
            kind="workspace",
            workspace_path=workspace,
            bus_url="http://127.0.0.1:1",
            operator_token=tmp / "operator.token",
            audit_log=tmp / "bus.jsonl",
            agent_bus_root=root,
        )
        isolated = Dashboard([project], ConversationStateStore(state_path))
        Handler.dashboard = isolated
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        host, port = server.server_address
        agents_path = f"/project/{project.key}/agents"

        def request(method: str, path: str, body: str | None = None) -> tuple[int, str, str]:
            connection = http.client.HTTPConnection(host, port, timeout=5)
            headers = {}
            if body is not None:
                headers["Content-Type"] = "application/x-www-form-urlencoded"
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read().decode("utf-8", errors="replace")
            location = response.getheader("Location") or ""
            status = response.status
            connection.close()
            return status, location, payload

        status, _location, page = request("GET", agents_path)
        if status != 200 or "Registered AgentBus agents" not in page:
            failures.append("isolated agents page did not render registered identities")
            return failures
        csrf = _extract_csrf(page)

        expired_status, expired_location, _expired = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode({"csrf": "not-the-token", "agent_id": "opus", "role": "Frontend"}),
        )
        if expired_status != 303 or "form expired" not in urllib.parse.unquote(expired_location).lower():
            failures.append("role POST without a valid CSRF token was not rejected")

        get_status, _get_location, _get_body = request("GET", f"{agents_path}/set-role")
        if get_status != 404:
            failures.append("role mutation must be POST-only")

        unknown_status, unknown_location, _unknown = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode({"csrf": csrf, "agent_id": "not-a-real-agent", "role": "Frontend"}),
        )
        if unknown_status != 303 or "Unknown agent" not in urllib.parse.unquote(unknown_location):
            failures.append("invalid agent IDs were not rejected")

        empty_status, empty_location, _empty = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode({"csrf": csrf, "agent_id": "opus", "role": "   "}),
        )
        if empty_status != 303 or "empty" not in urllib.parse.unquote(empty_location).lower():
            failures.append("empty roles were not rejected")

        long_role = "R" * (MAX_ROLE_LENGTH + 1)
        long_status, long_location, _long = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode({"csrf": csrf, "agent_id": "opus", "role": long_role}),
        )
        if long_status != 303 or "too long" not in urllib.parse.unquote(long_location).lower():
            failures.append("excessively long roles were not rejected")

        save_status, save_location, _save = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode({"csrf": csrf, "agent_id": "opus", "role": "  Frontend  "}),
        )
        if save_status != 303 or "action=role-saved" not in save_location:
            failures.append("valid role assignment did not persist through POST")
        saved_registry = json.loads(registry_path.read_text(encoding="utf-8"))
        saved_state = json.loads(state_path.read_text(encoding="utf-8"))
        if saved_registry.get("opus", {}).get("role") != "Frontend":
            failures.append("role assignment did not synchronize agents.json")
        if saved_registry.get("opus", {}).get("cliModel") != "claude-opus-5" or saved_registry.get("opus", {}).get("effort") != "high":
            failures.append("role assignment altered non-role registry fields")
        project_roles = saved_state.get("roles", {}).get(project.key, {})
        if not isinstance(project_roles, dict) or project_roles.get("opus", {}).get("role") != "Frontend":
            failures.append("role assignment did not persist in dashboard-state")
        if project_roles.get("opus", {}).get("default_role") != "manager":
            failures.append("role assignment did not capture the original default role")

        render_status, _render_location, rendered = request("GET", agents_path)
        if render_status != 200 or 'value="Frontend"' not in rendered or "opus" not in rendered:
            failures.append("rendered rows do not show the saved role")

        reset_status, reset_location, _reset = request(
            "POST",
            f"{agents_path}/reset-role",
            urllib.parse.urlencode({"csrf": csrf, "agent_id": "opus"}),
        )
        if reset_status != 303 or "action=role-reset" not in reset_location:
            failures.append("role reset POST did not succeed")
        reset_registry = json.loads(registry_path.read_text(encoding="utf-8"))
        reset_state = json.loads(state_path.read_text(encoding="utf-8"))
        if reset_registry.get("opus", {}).get("role") != "manager":
            failures.append("role reset did not restore the original/default role")
        if reset_registry.get("opus", {}).get("effort") != "high":
            failures.append("role reset altered non-role registry fields")
        reset_roles = reset_state.get("roles", {}).get(project.key, {})
        if isinstance(reset_roles, dict) and "opus" in reset_roles:
            failures.append("role reset left the dashboard override in place")
        reset_page_status, _reset_page_location, reset_page = request("GET", agents_path)
        if reset_page_status != 200 or 'value="manager"' not in reset_page:
            failures.append("rendered rows do not show the restored default role")

        if 'id="session-id-input"' not in reset_page:
            failures.append("agents page missing session-id assignment form")

        bad_session_status, bad_session_location, _bad_session = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode({"csrf": csrf, "session_id": "not-a-session", "role": "Commander"}),
        )
        if bad_session_status != 303 or "Session ID must be a Claude or Codex session id" not in urllib.parse.unquote(bad_session_location):
            failures.append("invalid session IDs were not rejected")

        empty_session_status, empty_session_location, _empty_session = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode({"csrf": csrf, "session_id": "   ", "role": "Commander"}),
        )
        if empty_session_status != 303 or "empty" not in urllib.parse.unquote(empty_session_location).lower():
            failures.append("empty session IDs were not rejected")

        unknown_bind_status, unknown_bind_location, _unknown_bind = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode(
                {
                    "csrf": csrf,
                    "session_id": "019ff1f7-cfea-7240-a6fe-f1ab2cb2fe4a",
                    "agent_id": "not-a-real-agent",
                    "role": "Commander",
                }
            ),
        )
        if unknown_bind_status != 303 or "Unknown agent" not in urllib.parse.unquote(unknown_bind_location):
            failures.append("session assignment to an unknown agent was not rejected")

        session_status, session_location, _session = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode(
                {
                    "csrf": csrf,
                    "session_id": "codex://threads/019ff1f7-cfea-7240-a6fe-f1ab2cb2fe4a",
                    "role": "Commander",
                }
            ),
        )
        if session_status != 303 or "action=role-saved" not in session_location:
            failures.append("valid session-id assignment did not persist through POST")
        session_state = json.loads(state_path.read_text(encoding="utf-8"))
        session_roles = session_state.get("roles", {}).get(project.key, {})
        if not isinstance(session_roles, dict) or session_roles.get("019ff1f7-cfea-7240-a6fe-f1ab2cb2fe4a", {}).get("role") != "Commander":
            failures.append("session-id assignment did not persist in dashboard-state")
        if session_roles.get("019ff1f7-cfea-7240-a6fe-f1ab2cb2fe4a", {}).get("subject") != "session":
            failures.append("session-id assignment did not store subject=session")
        unbound_registry = json.loads(registry_path.read_text(encoding="utf-8"))
        if unbound_registry.get("opus", {}).get("role") != "manager":
            failures.append("unbound session assignment changed a registry role")

        session_page_status, _session_page_location, session_page = request("GET", agents_path)
        if session_page_status != 200 or "019ff1f7-cfea-7240-a6fe-f1ab2cb2fe4a" not in session_page or 'value="Commander"' not in session_page:
            failures.append("rendered rows do not show the session assignment")

        bind_status, bind_location, _bind = request(
            "POST",
            f"{agents_path}/set-role",
            urllib.parse.urlencode(
                {
                    "csrf": csrf,
                    "session_id": "3d2f1e91-ead5-46f8-9382-66f2890e7eb5",
                    "agent_id": "opus",
                    "role": "Independent QA",
                }
            ),
        )
        if bind_status != 303 or "action=role-saved" not in bind_location:
            failures.append("session-id bind to a known agent did not persist")
        bound_registry = json.loads(registry_path.read_text(encoding="utf-8"))
        bound_state = json.loads(state_path.read_text(encoding="utf-8"))
        if bound_registry.get("opus", {}).get("role") != "Independent QA":
            failures.append("bound session assignment did not synchronize agents.json")
        if bound_registry.get("opus", {}).get("effort") != "high":
            failures.append("bound session assignment altered non-role registry fields")
        bound_roles = bound_state.get("roles", {}).get(project.key, {})
        if bound_roles.get("3d2f1e91-ead5-46f8-9382-66f2890e7eb5", {}).get("agent_id") != "opus":
            failures.append("bound session assignment did not store the agent id")

        bind_page_status, _bind_page_location, bind_page = request("GET", agents_path)
        if bind_page_status != 200 or "session 3d2f1e91-ead5-46f8-9382-66f2890e7eb5" not in bind_page:
            failures.append("rendered agent row does not show the bound session id")

        reset_session_status, reset_session_location, _reset_session = request(
            "POST",
            f"{agents_path}/reset-role",
            urllib.parse.urlencode({"csrf": csrf, "session_id": "3d2f1e91-ead5-46f8-9382-66f2890e7eb5"}),
        )
        if reset_session_status != 303 or "action=role-reset" not in reset_session_location:
            failures.append("session role reset POST did not succeed")
        reset_bound_registry = json.loads(registry_path.read_text(encoding="utf-8"))
        reset_bound_state = json.loads(state_path.read_text(encoding="utf-8"))
        if reset_bound_registry.get("opus", {}).get("role") != "manager":
            failures.append("session role reset did not restore the bound agent default")
        reset_bound_roles = reset_bound_state.get("roles", {}).get(project.key, {})
        if isinstance(reset_bound_roles, dict) and "3d2f1e91-ead5-46f8-9382-66f2890e7eb5" in reset_bound_roles:
            failures.append("session role reset left the session assignment in place")
    except Exception as error:  # noqa: BLE001 - checker must report unexpected failures
        failures.append(f"role checker crashed: {error}")
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if previous_dashboard is None:
            try:
                delattr(Handler, "dashboard")
            except AttributeError:
                pass
        else:
            Handler.dashboard = previous_dashboard
        shutil.rmtree(tmp, ignore_errors=True)
    return failures


def run_check(dashboard: Dashboard) -> int:
    failures = []
    warnings = []
    summaries = dashboard.summaries()
    if len({summary["key"] for summary in summaries}) != len(summaries):
        failures.append("project keys are not unique")
    home = dashboard.home()
    for required in (
        "Choose a project",
        "/assets/b-logo.png",
        'src="/assets/home-cat.jpg"',
        "/assets/home-cat-evil.jpg",
        "data-project-menu",
        "data-nav-toggle",
        "data-theme-set",
        "/assets/theme.js",
        "data-project-search",
        "Pinned",
    ):
        if required not in home:
            failures.append(f"home missing {required!r}")
    for project in dashboard.projects.values():
        summary = project.summary()
        if not summary["available"]:
            warnings.append(f"{project.key}: {summary['error']}")
            continue
        agents_page = dashboard.agents_page(project, {})
        if "Agents" not in agents_page:
            failures.append(f"{project.key}: agents page did not render")
        if 'id="role-presets"' not in agents_page:
            failures.append(f"{project.key}: agents page missing role presets")
        if 'id="session-id-input"' not in agents_page:
            failures.append(f"{project.key}: agents page missing session-id assignment")
        conversation_page = dashboard.messages_page(project, {})
        for required in ("Conversations", "Inbox", "Archived", "Trash"):
            if required not in conversation_page:
                failures.append(f"{project.key}: conversations page missing {required!r}")
    failures.extend(check_configuration())
    failures.extend(check_role_assignment())
    print(json.dumps({"projects": summaries, "warnings": warnings, "failures": failures}, indent=2))
    return 1 if failures else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the local Agent Bus Dashboard.")
    parser.add_argument("--config", type=Path, default=Path(os.environ.get("AGENT_DASHBOARD_CONFIG", str(Path.home() / ".agent-bus/dashboard.json"))))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--coordinator-db", type=Path, default=DEFAULT_COORDINATOR_DB)
    parser.add_argument("--coordinator-cli", type=Path, default=DEFAULT_COORDINATOR_CLI)
    parser.add_argument("--agent-bus-db", type=Path, default=DEFAULT_AGENT_BUS_DB)
    parser.add_argument("--agent-bus-cli", type=Path, default=DEFAULT_AGENT_BUS_CLI)
    parser.add_argument("--status-dir", type=Path, default=DEFAULT_STATUS_DIR)
    parser.add_argument(
        "--projects-root",
        type=Path,
        action="append",
        default=None,
        help="Discover each immediate folder plus nested marked repositories/apps under this root.",
    )
    parser.add_argument("--live-bus-url", default=DEFAULT_LIVE_BUS_URL)
    parser.add_argument("--operator-token", type=Path, default=DEFAULT_OPERATOR_TOKEN)
    parser.add_argument("--audit-log", type=Path, default=DEFAULT_AUDIT_LOG)
    parser.add_argument("--dashboard-state", type=Path, default=DEFAULT_DASHBOARD_STATE)
    parser.add_argument("--agent-bus-root", type=Path, default=DEFAULT_AGENT_BUS_ROOT)
    parser.add_argument("--check", action="store_true", help="Validate sources and render key pages without starting a server.")
    return parser


CONFIG_FIELDS = {
    "coordinator_db": ("Coordinator database", "Optional SQLite file from your existing Agent Coordinator."),
    "coordinator_cli": ("Coordinator command", "Optional executable; required only for sending through Coordinator."),
    "agent_bus_db": ("AgentBus history database", "Optional SQLite message store. The live broker works without this."),
    "agent_bus_cli": ("AgentBus history command", "Optional agent_comms_server.py; required only for sending to the SQLite store."),
    "agent_bus_root": ("AgentBus implementation folder", "Folder containing agents.json and the existing supervisor implementation. Blank uses ~/.agent-bus."),
    "status_dir": ("AgentBus status folder", "Optional status files for the SQLite source."),
}


def read_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read {path}. Use a JSON object with the keys shown in README.md.") from error
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object.")
    return data


def parse_settings(argv: list[str] | None = None) -> argparse.Namespace:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    initial = parser.parse_args(argv)
    initial.config = initial.config.expanduser().resolve()
    data = read_config(initial.config)
    allowed = {action.dest for action in parser._actions} - {"help", "check", "config"}
    unknown = set(data) - allowed
    if unknown:
        raise ValueError("Unknown configuration keys: " + ", ".join(sorted(unknown)))
    for key in allowed:
        env = os.environ.get("AGENT_DASHBOARD_" + key.upper())
        if env is not None:
            data[key] = env.split(os.pathsep) if key == "projects_root" else env
    parser.set_defaults(**data)
    args = parser.parse_args(argv)
    args.config = initial.config
    args.launch_argv = argv
    roots = args.projects_root if args.projects_root is not None else [DEFAULT_PROJECTS_ROOT]
    if not isinstance(roots, list) or not all(isinstance(item, (str, Path)) and str(item).strip() for item in roots):
        raise ValueError("projects_root must be an array of folder paths.")
    # Explicit repeated flags replace, rather than append to, configuration roots.
    if any(item == "--projects-root" or item.startswith("--projects-root=") for item in argv):
        roots = build_parser().parse_args(argv).projects_root
    args.projects_root = [Path(item).expanduser().resolve() for item in roots]
    for key in (*CONFIG_FIELDS, "operator_token", "audit_log", "dashboard_state"):
        value = getattr(args, key)
        if value is None and key in {"coordinator_db", "coordinator_cli", "agent_bus_db", "agent_bus_cli", "status_dir"}:
            continue
        if not isinstance(value, (str, Path)) or not str(value).strip():
            raise ValueError(f"{key} must be a non-empty path; omit it to use the default.")
        setattr(args, key, Path(value).expanduser().resolve())
    try:
        args.port = int(args.port)
        if not 1 <= args.port <= 65535:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError("port must be between 1 and 65535") from None
    validate_bus_url(args.live_bus_url)
    if not isinstance(args.host, str) or not args.host:
        raise ValueError("host must be an address; omit it to bind to 127.0.0.1")
    return args


def validate_bus_url(value: str) -> None:
    try:
        parsed = urllib.parse.urlparse(value)
        if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
            raise ValueError()
        parsed.port
    except (TypeError, ValueError):
        raise ValueError("Broker URL must be a loopback HTTP address, such as http://127.0.0.1:7717.") from None


def save_setup(settings: argparse.Namespace, form: dict[str, str]) -> argparse.Namespace:
    with REGISTRY_LOCK:
        data = read_config(settings.config)
        roots = [line.strip() for line in form.get("projects_root", "").splitlines() if line.strip()]
        if not roots:
            raise ValueError("Enter at least one projects folder. Create the folder first if needed.")
        if any(not Path(item).expanduser().is_absolute() or not Path(item).expanduser().is_dir() for item in roots):
            raise ValueError("Projects folders must exist. Use an absolute path or ~/Projects.")
        data["projects_root"] = roots
        for key in CONFIG_FIELDS:
            value = form.get(key, "").strip()
            if value:
                target = Path(value).expanduser()
                expected_directory = key in {"agent_bus_root", "status_dir"}
                unchanged = target.resolve() == getattr(settings, key)
                if not target.is_absolute() or (not unchanged and not (target.is_dir() if expected_directory else target.is_file())):
                    raise ValueError(f"{CONFIG_FIELDS[key][0]} must point to an existing {'folder' if expected_directory else 'file'}.")
                data[key] = value
            else:
                if key == "agent_bus_root":
                    data.pop(key, None)
                else:
                    data[key] = None
        url = form.get("live_bus_url", DEFAULT_LIVE_BUS_URL).strip()
        validate_bus_url(url)
        data["live_bus_url"] = url.rstrip("/")
        settings.config.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".dashboard-", dir=settings.config.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(data, stream, indent=2)
                stream.write("\n")
            os.replace(temporary, settings.config)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return parse_settings(settings.launch_argv)


def check_configuration() -> list[str]:
    failures = []
    with tempfile.TemporaryDirectory() as folder:
        base = Path(folder).resolve()
        config = base / "dashboard.json"
        config.write_text(json.dumps({"projects_root": [str(base / "absent")]}))
        args = parse_settings(["--config", str(config)])
        empty = Dashboard([], ConversationStateStore(base / "state.json"), args)
        if "Set up this machine" not in empty.home() or "Save local setup" not in empty.setup_page({}):
            failures.append("first-run guidance did not render without projects or sources")
        try:
            save_setup(args, {"projects_root": str(base), "live_bus_url": "https://example.com"})
            failures.append("setup accepted a non-loopback broker URL")
        except ValueError:
            pass
        args = save_setup(args, {"projects_root": str(base), "live_bus_url": DEFAULT_LIVE_BUS_URL})
        if args.projects_root != [base] or config.stat().st_mode & 0o077:
            failures.append("setup did not persist private configuration")
        if args.coordinator_db is not None or args.agent_bus_db is not None:
            failures.append("blank optional sources were not disabled")
        missing = base / "offline.db"
        saved = read_config(config)
        saved["coordinator_db"] = str(missing)
        config.write_text(json.dumps(saved))
        args = parse_settings(["--config", str(config)])
        page = Dashboard([], state_store=ConversationStateStore(base / "state.json"), settings=args).setup_page({})
        if str(missing) not in page:
            failures.append("missing configured source was hidden")
        args = save_setup(args, {"projects_root": str(base), "coordinator_db": str(missing), "live_bus_url": DEFAULT_LIVE_BUS_URL})
        if args.coordinator_db != missing:
            failures.append("unrelated save discarded disconnected source")
        linked_root = base / "links"
        linked_root.mkdir()
        external = base / "external"
        external.mkdir()
        (linked_root / "external").symlink_to(external, target_is_directory=True)
        args.projects_root = [linked_root]
        if not any(project.workspace_path == external for project in make_projects(args)):
            failures.append("symlinked project outside root was not discovered")
        second = base / "second"
        second.mkdir()
        override = parse_settings(["--config", str(config), "--projects-root", str(second)])
        if override.projects_root != [second]:
            failures.append("explicit projects root did not replace config roots")
        state = ConversationStateStore(base / "state.json")
        state.path.write_text(json.dumps({"extension": {"keep": True}, "roles": {}, "conversations": {}}))
        data = state._load()
        state._write(data)
        if json.loads(state.path.read_text()).get("extension") != {"keep": True}:
            failures.append("state write discarded unknown keys")
    return failures


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_settings(argv)
    except ValueError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2
    dashboard = Dashboard(make_projects(args), ConversationStateStore(args.dashboard_state), args)
    if args.check:
        return run_check(dashboard)
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        print(f"warning: binding to {args.host} may expose agent messages to the network", file=sys.stderr)
    Handler.dashboard = dashboard
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Agent Bus Dashboard: http://{args.host}:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
