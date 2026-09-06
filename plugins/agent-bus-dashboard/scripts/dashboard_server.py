#!/usr/bin/env python3
"""Unified localhost dashboard for the existing coordinator and AgentBus stores.

THESIS: One operator, many agents, many projects. The dashboard is a switchboard: every page says who is live,
        what they are doing, and what the operator can do next.
OWN-WORLD: Paper (Day), graphite (Night), and bone-on-void with a vermilion signal (Evil). Serif titles on a sans
        instrument body; identifiers and time in mono. Agent identity is a provider mark on a quiet tile; status is a dot plus a label.
STORY: Choose a project, read its live roster and tasks, supervise its agents, then work through complete conversations
        across Inbox, Archived, and Trash.
FIRST VIEWPORT: Status bar with broker state, project dock, page title, then the numbers and the roster.
FORM: Layered panels with hairlines, stat tiles, a responsive roster list, and an index/detail conversation workspace.
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
            {"name": subscription, "turns": 0, "tokens": 0, "costUSD": 0.0, "agents": [], "labels": []},
        )
        group["turns"] += int(usage["turns"])
        group["tokens"] += int(usage["tokens"])
        group["costUSD"] += float(usage["costUSD"])
        group["agents"].append(str(agent.get("id") or ""))
        group["labels"].append(agent_title(agent))
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
            conversation["latest_sender"] = clean_text(message.get("sender"))
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
        return {"version": 1, "conversations": {}, "roles": {}, "pinned_projects": [], "hidden_projects": []}

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
            "hidden_projects": self._pinned_keys(data.get("hidden_projects")),
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
            hidden = self._pinned_keys(data.get("hidden_projects"))
            if pinned:
                if key not in current:
                    current.append(key)
                hidden = [item for item in hidden if item != key]
            else:
                current = [item for item in current if item != key]
            data["pinned_projects"] = current
            data["hidden_projects"] = hidden
            self._write(data)

    def hidden_projects(self) -> list[str]:
        with self.lock:
            return list(self._load()["hidden_projects"])

    def set_hidden(self, project_key: str, hidden: bool) -> None:
        key = clean_text(project_key)
        if not key:
            raise ValueError("Unknown project")
        with self.lock:
            data = self._load()
            current = self._pinned_keys(data.get("hidden_projects"))
            pinned = self._pinned_keys(data.get("pinned_projects"))
            if hidden:
                if key not in current:
                    current.append(key)
                pinned = [item for item in pinned if item != key]
            else:
                current = [item for item in current if item != key]
            data["hidden_projects"] = current
            data["pinned_projects"] = pinned
            self._write(data)

    def hide_projects(self, keys: list[str]) -> None:
        wanted = self._pinned_keys(keys)
        if not wanted:
            return
        with self.lock:
            data = self._load()
            current = self._pinned_keys(data.get("hidden_projects"))
            seen = set(current)
            for key in wanted:
                if key not in seen:
                    current.append(key)
                    seen.add(key)
            data["hidden_projects"] = current
            data["pinned_projects"] = [item for item in self._pinned_keys(data.get("pinned_projects")) if item not in seen]
            self._write(data)

    def archive_conversations(self, mapping: dict[str, list[str]]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self.lock:
            data = self._load()
            conversations = data.setdefault("conversations", {})
            for project_key, ids in mapping.items():
                key = clean_text(project_key)
                if not key:
                    continue
                project = conversations.setdefault(key, {})
                for conversation_id in ids:
                    cid = clean_text(conversation_id)[:80]
                    if not cid:
                        continue
                    project[cid] = {"status": "archived", "updated": now}
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
                    "effort": clean_text(item.get("effort") or item.get("reasoningEffort") or item.get("reasoning_effort")),
                    "cli": cli,
                    "auth": clean_text(item.get("auth")) or "Unknown subscription",
                    "workdir": clean_text(item.get("workdir")),
                    "description": clean_text(item.get("description")),
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

    def tasks(self, snapshot: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Read-only task view: coordinator tasks table or live AgentBus tasks touching this project's agents."""
        if self.kind == "coordinator":
            if self.db_path is None:
                return []
            query = """
                SELECT id, title, description, creator, assignee, priority, status, created_ts, updated_ts
                FROM tasks ORDER BY updated_ts DESC LIMIT 80
            """
            try:
                with connect_read_only(self.db_path) as connection:
                    rows = connection.execute(query).fetchall()
            except sqlite3.Error:
                return []
            tasks = []
            for row in rows:
                item = dict(row)
                tasks.append(
                    {
                        "id": str(item.get("id") or ""),
                        "title": clean_text(item.get("title")) or f"Task {item.get('id')}",
                        "brief": preview(item.get("description"), 140),
                        "assigner": clean_text(item.get("creator")),
                        "assignee": clean_text(item.get("assignee")),
                        "state": clean_text(item.get("status")) or "todo",
                        "priority": clean_text(item.get("priority")) or "normal",
                        "round": None,
                        "attempts": None,
                        "max_retries": None,
                        "updated": display_time(item.get("updated_ts")),
                        "updated_key": timestamp_key(item.get("updated_ts")),
                    }
                )
            return tasks
        if self.kind != "workspace":
            return []
        data = snapshot if snapshot is not None else self._live_snapshot()
        agent_ids = {str(item.get("id")) for item in self._workspace_roster(data) if item.get("id")}
        raw = data.get("tasks", [])
        if not isinstance(raw, list):
            return []
        tasks = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            assigner = clean_text(item.get("assigner"))
            assignee = clean_text(item.get("assignee"))
            if assigner not in agent_ids and assignee not in agent_ids:
                continue
            try:
                round_number = int(item.get("round") or 0)
            except (TypeError, ValueError):
                round_number = 0
            try:
                attempts = int(item.get("attempts") or 0)
            except (TypeError, ValueError):
                attempts = 0
            try:
                max_retries = int(item.get("maxRetries") or 0)
            except (TypeError, ValueError):
                max_retries = 0
            tasks.append(
                {
                    "id": clean_text(item.get("id")),
                    "title": clean_text(item.get("title")) or clean_text(item.get("id")) or "Task",
                    "brief": preview(item.get("brief") or item.get("context"), 140),
                    "assigner": assigner,
                    "assignee": assignee,
                    "state": clean_text(item.get("state")) or "unknown",
                    "priority": "",
                    "round": round_number,
                    "attempts": attempts,
                    "max_retries": max_retries,
                    "updated": display_time(item.get("updatedAt") or item.get("createdAt")),
                    "updated_key": timestamp_key(item.get("updatedAt") or item.get("createdAt")),
                }
            )
        return sorted(tasks, key=lambda task: task["updated_key"], reverse=True)

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
                    "effort": registry_effort(item),
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
                entry = registry.get(str(agent.get("id")))
                agent["in_registry"] = entry is not None
                agent["listed"] = "live"
                if entry and not clean_text(agent.get("effort")):
                    agent["effort"] = entry.get("effort", "")
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
                        "effort": item.get("effort", ""),
                        "role": item["role"],
                        "parent_id": "",
                        "status": "registered",
                        "doing": "Registered AgentBus identity · not attached here",
                        "last_active": "",
                        "in_registry": True,
                        "listed": "registered",
                        "harness": item["harness"],
                        "description": item["description"],
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


STATUS_LABELS = {
    "working": "Working",
    "active": "Active",
    "waiting": "Waiting",
    "idle": "Idle",
    "waiting_review": "Waiting review",
    "blocked": "Blocked",
    "stalled": "Stalled",
    "stale": "Stale",
    "offline": "Offline",
    "failed": "Failed",
    "unregistered": "Unregistered",
    "registered": "Registered",
    "session": "Session",
    "unknown": "Unknown",
}
HARNESS_LABELS = {
    "claude": ("Claude Code", "C"),
    "codex": ("Codex CLI", "X"),
    "grok": ("Grok CLI", "G"),
    "kimi": ("Kimi CLI", "K"),
    "opencode": ("OpenCode", "O"),
    "cursor": ("Cursor", "U"),
    "gemini": ("Gemini CLI", "M"),
    "aider": ("Aider", "A"),
}
HARNESS_PROVIDERS = {
    "claude": "Anthropic",
    "codex": "OpenAI",
    "grok": "xAI",
    "kimi": "Moonshot AI",
    "gemini": "Google",
}
MODEL_PROVIDERS = (
    ("claude", "Anthropic"),
    ("fable", "Anthropic"),
    ("opus", "Anthropic"),
    ("sonnet", "Anthropic"),
    ("haiku", "Anthropic"),
    ("gpt", "OpenAI"),
    ("codex", "OpenAI"),
    ("o1", "OpenAI"),
    ("o3", "OpenAI"),
    ("o4", "OpenAI"),
    ("grok", "xAI"),
    ("kimi", "Moonshot AI"),
    ("moonshot", "Moonshot AI"),
    ("gemini", "Google"),
    ("deepseek", "DeepSeek"),
    ("glm", "Zhipu"),
    ("qwen", "Alibaba"),
    ("llama", "Meta"),
    ("mistral", "Mistral"),
)
TASK_STATE_CLASSES = {
    "in_progress": "working",
    "working": "working",
    "started": "working",
    "assigned": "waiting",
    "ready": "waiting",
    "todo": "idle",
    "open": "idle",
    "submitted": "waiting_review",
    "review": "waiting_review",
    "waiting_review": "waiting_review",
    "changes_requested": "blocked",
    "blocked": "blocked",
    "failed": "failed",
    "cancelled": "offline",
    "canceled": "offline",
    "accepted": "active",
    "done": "active",
    "completed": "active",
    "approved": "active",
}
TASK_OPEN_STATES = {"blocked", "ready", "assigned", "in_progress", "submitted", "changes_requested", "todo", "open", "review", "working", "started"}


def status_class(value: Any) -> str:
    slug = "".join(character if character.isalnum() or character == "_" else "-" for character in clean_text(value).lower())
    return slug.strip("-") or "unknown"


def status_label(value: Any) -> str:
    key = clean_text(value).lower()
    if not key:
        return "Unknown"
    return STATUS_LABELS.get(key, key.replace("_", " ").capitalize())


def harness_key(value: Any) -> str:
    key = clean_text(value).lower()
    if not key:
        return ""
    for known in HARNESS_LABELS:
        if key == known or key.startswith(known):
            return known
    return "other"


def infer_harness(agent: dict[str, Any]) -> str:
    key = harness_key(agent.get("cli")) or harness_key(agent.get("harness"))
    if key and key != "other":
        return key
    model = clean_text(agent.get("model")).lower()
    for needle, _provider in MODEL_PROVIDERS:
        if needle in model:
            if needle in {"claude", "fable", "opus", "sonnet", "haiku"}:
                return "claude"
            if needle in {"gpt", "codex", "o1", "o3", "o4"}:
                return "codex"
            if needle == "grok":
                return "grok"
            if needle in {"kimi", "moonshot"}:
                return "kimi"
            if needle == "gemini":
                return "gemini"
            break
    if str(agent.get("role") or "").lower() == "human" or str(agent.get("id") or "") == "operator":
        return "human"
    identity = clean_text(f"{agent.get('id') or ''} {agent.get('name') or ''}").lower()
    for known in HARNESS_LABELS:
        if known in identity:
            return known
    return key or "other"


def harness_label(key: str) -> str:
    if key == "human":
        return "Human"
    return HARNESS_LABELS.get(key, ("Other harness", "?"))[0]


def provider_label(key: str, model: Any) -> str:
    text = clean_text(model).lower()
    for needle, provider in MODEL_PROVIDERS:
        if needle in text:
            return provider
    return HARNESS_PROVIDERS.get(key, "")


def monogram_text(value: Any) -> str:
    text = clean_text(value)
    for character in text:
        if character.isalnum():
            return character.upper()
    return "?"


PROVIDER_NAMES = {
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "xai": "xAI",
    "cursor": "Cursor",
    "zai": "Z.ai",
    "moonshot": "Moonshot AI",
    "google": "Google",
    "deepseek": "DeepSeek",
    "alibaba": "Alibaba",
    "meta": "Meta",
    "mistral": "Mistral",
    "opencode": "OpenCode",
    "aider": "Aider",
    "human": "Human operator",
    "agent": "Agent",
}
MODEL_PROVIDER_KEYS = (
    ("claude", "anthropic"),
    ("fable", "anthropic"),
    ("mythos", "anthropic"),
    ("opus", "anthropic"),
    ("sonnet", "anthropic"),
    ("haiku", "anthropic"),
    ("gpt", "openai"),
    ("codex", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("o4", "openai"),
    ("grok", "xai"),
    ("kimi", "moonshot"),
    ("moonshot", "moonshot"),
    ("glm", "zai"),
    ("zhipu", "zai"),
    ("gemini", "google"),
    ("deepseek", "deepseek"),
    ("qwen", "alibaba"),
    ("llama", "meta"),
    ("mistral", "mistral"),
    ("mixtral", "mistral"),
    ("devstral", "mistral"),
    ("cursor", "cursor"),
    ("composer", "cursor"),
)
HARNESS_PROVIDER_KEYS = {
    "claude": "anthropic",
    "codex": "openai",
    "grok": "xai",
    "kimi": "moonshot",
    "gemini": "google",
    "cursor": "cursor",
    "opencode": "opencode",
    "aider": "aider",
    "human": "human",
}
# Monochrome marks, 24x24, painted with currentColor so every theme can tint them.
PROVIDER_MARKS = {
    "anthropic": '<path fill="currentColor" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/>',
    "openai": '<path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>',
    "xai": '<path fill="currentColor" d="M2.6 3h4.1L21.6 21h-4.1zM21.4 3l-8 10.1-2-2.5L17.3 3zM2.4 21l8-10.1 2 2.6L6.5 21z"/>',
    "cursor": '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M12 2.4l8.4 4.8v9.6L12 21.6l-8.4-4.8V7.2z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M3.6 7.2L12 12l8.4-4.8M12 12v9.6"/>',
    "zai": '<path fill="currentColor" d="M4 3.5h16v3.2L9.9 17.4H20v3.1H4v-3.2L14.1 6.6H4z"/>',
    "moonshot": '<path fill="currentColor" d="M14.2 2.2a10 10 0 1 0 7.6 16.6A8.6 8.6 0 0 1 14.2 2.2z"/>',
    "google": '<path fill="currentColor" d="M12 1.5c.7 5.9 4.6 9.8 10.5 10.5-5.9.7-9.8 4.6-10.5 10.5C11.3 16.6 7.4 12.7 1.5 12 7.4 11.3 11.3 7.4 12 1.5z"/>',
    "deepseek": '<path fill="currentColor" d="M21.6 6.2c-.7.6-1.5 1.7-2 2.6-1.7-2.2-4.4-3.5-7.4-3.5-4.7 0-8.6 3.1-9.8 7.3 1 .9 2.2 1.6 3.5 2.1l-1.2 3.6 3.6-2.4c.9.4 1.9.6 2.9.7L10.5 19h3.4l-.1-2.4c3.5-.4 6.3-2.8 7.1-6.1.9-.6 1.6-1.6 2-2.8.2-.6-.3-1.2-.9-1.1-.2 0-.3 0-.4-.4zM9 10.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>',
    "alibaba": '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z"/><path fill="currentColor" d="M12 7.6l4.1 2.35v4.1L12 16.4l-4.1-2.35v-4.1z"/>',
    "meta": '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6.6 6.8C3.6 6.8 2 10 2 12s1.6 5.2 4.6 5.2c4.4 0 6.4-10.4 10.8-10.4 3 0 4.6 3.2 4.6 5.2s-1.6 5.2-4.6 5.2c-4.4 0-6.4-10.4-10.8-10.4z"/>',
    "mistral": '<path fill="currentColor" d="M2 3h4v4H2zm16 0h4v4h-4zM2 7h8v4H2zm12 0h8v4h-8zM2 11h20v4H2zm0 4h4v4H2zm8 0h4v4h-4zm8 0h4v4h-4zM2 19h4v2H2zm16 0h4v2h-4z"/>',
    "opencode": '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M4 6l6 6-6 6M12.5 18h7.5"/>',
    "aider": '<path fill="currentColor" d="M12 3l8 18h-3.3l-2-4.9H9.3L7.3 21H4zm-1.8 10.3h3.6L12 8.6z"/>',
    "human": '<circle fill="currentColor" cx="12" cy="7.5" r="4"/><path fill="currentColor" d="M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5z"/>',
    "agent": '<circle fill="currentColor" cx="12" cy="12" r="3.2"/><circle fill="none" stroke="currentColor" stroke-width="1.8" cx="12" cy="12" r="8.5"/>',
}
EFFORT_TOKENS = ("minimal", "low", "medium", "high", "xhigh", "max", "ultra")
MODEL_TOKEN_CASE = {
    "gpt": "GPT",
    "glm": "GLM",
    "o1": "o1",
    "o3": "o3",
    "o4": "o4",
    "k2": "K2",
    "k1.5": "K1.5",
    "r1": "R1",
    "v3": "V3",
    "ai": "AI",
    "xai": "xAI",
}
GENERIC_ROLES = {"", "worker", "agent", "human", "interactive", "message peer", "unknown", "none", "n/a"}


def provider_key(harness: Any, model: Any = "", agent: dict[str, Any] | None = None) -> str:
    agent = agent or {}
    text = clean_text(model or agent.get("model")).lower()
    if not text:
        text = clean_text(agent.get("id")).lower()
    for needle, key in MODEL_PROVIDER_KEYS:
        if needle in text:
            return key
    key = HARNESS_PROVIDER_KEYS.get(clean_text(harness).lower())
    if key:
        return key
    if str(agent.get("role") or "").lower() == "human" or str(agent.get("id") or "") == "operator":
        return "human"
    return "agent"


def provider_name(key: str) -> str:
    return PROVIDER_NAMES.get(key, "Agent")


def split_model_effort(model: Any) -> tuple[str, str]:
    """Split a trailing effort token off a model string: 'gpt-5.6-sol-high' -> ('gpt-5.6-sol', 'high')."""
    text = clean_text(model)
    lowered = text.lower()
    for token in sorted(EFFORT_TOKENS, key=len, reverse=True):
        for separator in ("-", "_", " ", ":", "/"):
            suffix = separator + token
            if lowered.endswith(suffix) and len(lowered) > len(suffix):
                return text[: -len(suffix)], token
    return text, ""


def registry_effort(item: dict[str, Any]) -> str:
    """Effort as written in agents.json: `effort`, `reasoning` (Codex), or the same keys under harnessOptions."""
    options = item.get("harnessOptions") if isinstance(item.get("harnessOptions"), dict) else {}
    for source in (item, options):
        for key in ("effort", "reasoning", "reasoningEffort", "reasoning_effort", "model_reasoning_effort"):
            text = clean_text(source.get(key)).lower()
            if text and text not in {"none", "off", "false", "default", "auto"}:
                return text
    return ""


CODEX_DEFAULT_EFFORT: dict[str, tuple[float, str]] = {}


def codex_default_effort() -> str:
    """The Codex CLI's own default from ~/.codex/config.toml, used when neither roster nor registry names an effort."""
    path = Path.home() / ".codex" / "config.toml"
    try:
        stamp = path.stat().st_mtime
    except OSError:
        return ""
    cached = CODEX_DEFAULT_EFFORT.get(str(path))
    if cached and cached[0] == stamp:
        return cached[1]
    value = ""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("["):
                break  # only the top-level table holds the global default
            match = re.match(r'model_reasoning_effort\s*=\s*"([^"]+)"', stripped)
            if match:
                value = match.group(1).strip().lower()
                break
    except OSError:
        value = ""
    CODEX_DEFAULT_EFFORT[str(path)] = (stamp, value)
    return value


def agent_effort(agent: dict[str, Any]) -> str:
    for key in ("effort", "reasoningEffort", "reasoning_effort", "reasoning", "thinking", "thinkingLevel", "thinking_level"):
        value = agent.get(key)
        if isinstance(value, dict):
            value = value.get("effort") or value.get("level")
        text = clean_text(value).lower()
        if text and text not in {"none", "off", "false", "default", "auto"}:
            return text
    inline = split_model_effort(agent.get("model"))[1]
    if inline:
        return inline
    if harness_key(agent.get("cli")) == "codex" or harness_key(agent.get("harness")) == "codex":
        return codex_default_effort()
    return ""


def model_display(model: Any, effort: Any = "") -> str:
    """Turn a model id into a readable name: 'claude-fable-5-1' -> 'Fable 5.1', 'gpt-5.6-sol' -> 'GPT 5.6 sol'."""
    text, inline_effort = split_model_effort(model)
    effort = clean_text(effort).lower() or inline_effort
    text = clean_text(text)
    if not text:
        return ""
    if text.lower() == "control-panel":
        return "Control panel"
    if "/" in text:
        text = text.rsplit("/", 1)[-1]
    tokens = [token for token in re.split(r"[-_\s]+", text) if token]
    if not tokens:
        return ""
    lowered = [token.lower() for token in tokens]
    if lowered[0] in {"claude", "anthropic"} and len(tokens) > 1 and lowered[1] in {"fable", "mythos", "opus", "sonnet", "haiku"}:
        tokens, lowered = tokens[1:], lowered[1:]
    words: list[str] = []
    for token, low in zip(tokens, lowered):
        if re.fullmatch(r"\d{8}", low):
            continue  # drop date stamps like 20251001
        if re.fullmatch(r"\d+(\.\d+)?", low) and words and re.search(r"\d$", words[-1]) and "." not in words[-1].split(" ")[-1]:
            words[-1] = f"{words[-1]}.{low}"
            continue
        if low in MODEL_TOKEN_CASE:
            words.append(MODEL_TOKEN_CASE[low])
        elif re.fullmatch(r"\d+(\.\d+)?", low):
            words.append(low)
        elif len(low) <= 2 and low.isalpha():
            words.append(low.upper())
        else:
            words.append(token[0].upper() + token[1:] if len(words) == 0 else token.lower())
    label = " ".join(words)
    if effort:
        label = f"{label} {effort}"
    return label


def agent_title(agent: dict[str, Any]) -> str:
    """The name a human would use for an agent: its role, else its display name, else its id."""
    role = clean_text(agent.get("role"))
    if role.lower() not in GENERIC_ROLES:
        return role
    name = clean_text(agent.get("name"))
    agent_id = clean_text(agent.get("id"))
    if name and name != agent_id:
        return name
    return agent_id or "Unknown agent"


def agent_model_line(agent: dict[str, Any], with_provider: bool = False) -> str:
    key = provider_key(infer_harness(agent), agent.get("model"), agent)
    label = model_display(agent.get("model"), agent_effort(agent))
    if not label:
        label = "Model not reported" if key in {"agent", "human"} else provider_name(key)
    if with_provider and key not in {"agent", "human"} and provider_name(key).lower() not in label.lower():
        return f"{provider_name(key)} {label}"
    return label


def avatar_html(agent: dict[str, Any] | None = None, size: str = "", harness: str = "", model: Any = "", label: str = "") -> str:
    agent = agent or {}
    harness = harness or infer_harness(agent)
    key = provider_key(harness, model or agent.get("model"), agent)
    mark = PROVIDER_MARKS.get(key, PROVIDER_MARKS["agent"])
    title = label or " · ".join(part for part in (provider_name(key), model_display(model or agent.get("model"))) if part)
    classes = " ".join(part for part in ("avatar", size, f"p-{key}") if part)
    return (
        f'<span class="{classes}" title="{esc(title)}" aria-hidden="true">'
        f'<svg viewBox="0 0 24 24" focusable="false">{mark}</svg></span>'
    )


def monogram_html(name: Any, harness: str, size: str = "") -> str:
    """Compatibility shim: callers that only know an id and a harness get a provider mark."""
    size = {"monogram": "", "monogram-s": "avatar-s", "monogram-l": "avatar-l"}.get(size, size)
    return avatar_html({"id": clean_text(name)}, size=size, harness=harness)


def task_state_class(value: Any) -> str:
    key = clean_text(value).lower()
    return TASK_STATE_CLASSES.get(key, "idle")


def task_state_label(value: Any) -> str:
    key = clean_text(value).lower()
    return key.replace("_", " ").capitalize() if key else "Unknown"


def format_short(value: Any) -> str:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return "0"
    if number >= 1_000_000:
        return f"{number / 1_000_000:.1f}M".replace(".0M", "M")
    if number >= 10_000:
        return f"{number / 1_000:.1f}K".replace(".0K", "K")
    return f"{number:,}"


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
        hidden_keys = set(self.state_store.hidden_projects())
        pinned_rank = {key: index for index, key in enumerate(pinned_keys)}
        items = []
        for project in self.projects.values():
            item = project.summary()
            item["kind"] = project.kind
            item["hidden"] = item["key"] in hidden_keys
            item["pinned"] = item["key"] in pinned_rank and not item["hidden"]
            items.append(item)

        def sort_key(item: dict[str, Any]) -> tuple[int, int, str]:
            if item["hidden"]:
                return (3, 0, item["name"].casefold())
            if item["pinned"]:
                return (0, pinned_rank.get(item["key"], 10_000), item["name"].casefold())
            if item.get("kind") != "workspace":
                return (1, 0, item["name"].casefold())
            return (2, 0, item["name"].casefold())

        return sorted(items, key=sort_key)

    def visible_catalog(self) -> list[dict[str, Any]]:
        return [item for item in self.catalog() if not item.get("hidden")]

    def hidden_notice(self, project: ProjectSource) -> str:
        if project.key not in self.state_store.hidden_projects():
            return ""
        return (
            f'<aside class="notice notice-hidden">This project is hidden from the register and the dock. '
            f'<form class="inline-form" method="post" action="/project/{esc(project.key)}/flags/unhide">'
            f'<input type="hidden" name="csrf" value="{esc(self.csrf_token)}">'
            f'<button class="link-btn" type="submit">Show it again</button></form></aside>'
        )

    def project(self, key: str) -> ProjectSource:
        project = self.projects.get(key)
        if project is None:
            raise KeyError(key)
        return project

    @staticmethod
    def agent_index(agents: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        index: dict[str, dict[str, Any]] = {}
        for agent in agents:
            agent_id = clean_text(agent.get("id"))
            if agent_id and agent_id not in index:
                index[agent_id] = agent
        return index

    @staticmethod
    def who(index: dict[str, dict[str, Any]], agent_id: Any) -> dict[str, Any]:
        key = clean_text(agent_id)
        if key in index:
            return index[key]
        if key in {"operator", "human"}:
            return {"id": key, "name": "Operator", "role": "human", "model": ""}
        if key == "all":
            return {"id": key, "name": "All project agents", "role": "", "model": ""}
        return {"id": key, "name": key, "role": "", "model": ""}

    def who_label(self, index: dict[str, dict[str, Any]], agent_id: Any) -> str:
        agent = self.who(index, agent_id)
        title = agent_title(agent)
        raw = clean_text(agent_id)
        tip = raw if raw and raw != title else ""
        return f'<span class="who" title="{esc(tip)}">{esc(title)}</span>' if tip else f'<span class="who">{esc(title)}</span>'

    def who_names(self, index: dict[str, dict[str, Any]], ids: list[Any]) -> str:
        return ", ".join(agent_title(self.who(index, item)) for item in ids)

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
                <input id="{esc(control_id)}" name="role" list="role-presets" value="{esc(current_role)}" maxlength="{MAX_ROLE_LENGTH}" autocomplete="off" required placeholder="Role">
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

    # ---------- shared fragments ----------

    def broker_status(self) -> dict[str, Any]:
        bus_url = ""
        for project in self.projects.values():
            if project.kind == "workspace":
                bus_url = project.bus_url
                break
        if not bus_url and self.settings is not None:
            bus_url = str(getattr(self.settings, "live_bus_url", "") or "")
        if not bus_url:
            return {"known": False, "reachable": False, "live": 0, "waiting": 0, "stalled": 0, "observed": "", "error": ""}
        probe = ProjectSource("probe", "Probe", "Probe", "", "", "workspace", bus_url=bus_url)
        snapshot = probe._live_snapshot()
        roster = snapshot.get("roster", [])
        roster = roster if isinstance(roster, list) else []
        live = [
            item
            for item in roster
            if isinstance(item, dict) and item.get("workdir") and str(item.get("status") or "") not in {"offline", "unregistered"}
        ]
        waiting = snapshot.get("waiting", [])
        return {
            "known": True,
            "reachable": snapshot.get("_reachable", True) is not False,
            "live": len(live),
            "waiting": len(waiting) if isinstance(waiting, list) else 0,
            "stalled": sum(1 for item in live if item.get("stalled")),
            "observed": clean_text(snapshot.get("_observedAt")),
            "error": clean_text(snapshot.get("_error")),
        }

    def render_live_pill(self, broker: dict[str, Any], compact: bool = False) -> str:
        if not broker.get("known"):
            return '<span class="live-pill" data-broker-state="unknown"><span class="dot is-ring"></span><span class="text">Broker</span> <b>not configured</b></span>'
        if not broker.get("reachable"):
            seen = f' · <span class="text">last seen {esc(display_time(broker.get("observed")))}</span>' if broker.get("observed") else ""
            return (
                f'<span class="live-pill" data-broker-state="disconnected" title="{esc(broker.get("error") or "AgentBus broker unavailable")}">'
                f'<span class="dot dot-crit is-ring"></span><span class="text">Broker</span> <b>disconnected</b>{seen}</span>'
            )
        stalled = f' · <b>{broker["stalled"]}</b> stalled' if broker.get("stalled") else ""
        waiting = "" if compact else f' · <b>{broker["waiting"]}</b> waiting'
        return (
            f'<span class="live-pill" data-broker-state="connected"><span class="dot dot-ok"></span>'
            f'<span class="text">Broker</span> <b>connected</b><span class="pill-counts"> · <b>{broker["live"]}</b> live{waiting}{stalled}</span></span>'
        )

    @staticmethod
    def status_pill(status: Any, hook: bool = False) -> str:
        klass = status_class(status)
        attrs = ' data-agent-status' if hook else ""
        label = f'<span data-agent-status-label>{esc(status_label(status))}</span>' if hook else esc(status_label(status))
        return f'<span class="status-pill status-{esc(klass)}"{attrs}><span class="dot"></span>{label}</span>'

    @staticmethod
    def harness_chip(key: str) -> str:
        if not key:
            return ""
        return f'<span class="harness-chip"><span class="swatch h-{esc(key)}"></span>{esc(harness_label(key))}</span>'

    @staticmethod
    def kind_label(kind: str) -> str:
        return {"workspace": "Local workspace", "coordinator": "Coordinator source", "agent-bus": "Bus history source"}.get(kind, kind)

    @staticmethod
    def cell(label: str, inner: str, klass: str) -> str:
        return f'<div class="{klass}"><span class="cell-label">{esc(label)}</span>{inner}</div>'

    def render_mascot(self) -> str:
        return """
          <figure class="mascot">
            <div class="mascot-photo">
              <img class="mascot-plain" src="/assets/home-cat.jpg" alt="A long-haired grey tabby cat sitting on a kitchen counter">
              <img class="mascot-evil" src="/assets/home-cat-evil.jpg?v=cape" alt="The same cat with MS Paint horns, a cape, a pitchfork, and a dead mouse">
            </div>
            <figcaption>
              <strong>Bus cat is on duty.</strong>
              <span class="mascot-caption-plain">Watching every project from the counter. Pin the ones you keep opening, hide the ones you don’t.</span>
              <span class="mascot-caption-evil">Evil mode engaged. The mouse had it coming. Pin the projects you keep opening, hide the rest.</span>
            </figcaption>
          </figure>
        """

    @staticmethod
    def empty_state(title: str, copy: str, actions: str = "", compact: bool = False, cat: bool = False) -> str:
        if cat:
            icon = (
                '<span class="empty-cat" aria-hidden="true"><img class="mascot-plain" src="/assets/home-cat.jpg" alt="">'
                '<img class="mascot-evil" src="/assets/home-cat-evil.jpg?v=cape" alt=""></span>'
            )
        else:
            icon = '<span class="empty-icon" aria-hidden="true"><img src="/assets/b-logo.png?v=cat" alt=""></span>'
        klass = "empty-state empty-compact" if compact else "empty-state"
        buttons = f'<div class="empty-actions">{actions}</div>' if actions else ""
        return f'<div class="{klass}">{icon}<h3>{esc(title)}</h3><p>{copy}</p>{buttons}</div>'

    # ---------- project register ----------

    def project_filter_text(self, item: dict[str, Any]) -> str:
        return clean_text(
            " ".join(str(item.get(key, "")) for key in ("name", "short_name", "path", "description", "kind"))
        ).lower()

    def render_project_pin_form(self, item: dict[str, Any], compact: bool = False) -> str:
        pinned = bool(item.get("pinned"))
        action = "unpin" if pinned else "pin"
        label = "Unpin" if pinned else "Pin"
        klass = "dock-pin" if compact else "flag-form"
        text = ("★" if pinned else "☆") if compact else label
        button_class = "" if compact else ' class="flag-btn"'
        return (
            f'<form class="{klass}" method="post" action="/project/{esc(item["key"])}/flags/{action}" data-project-pin>'
            f'<input type="hidden" name="csrf" value="{esc(self.csrf_token)}">'
            f'<button{button_class} type="submit" aria-pressed="{"true" if pinned else "false"}" aria-label="{label} {esc(item["short_name"])}" title="{label}">{text}</button>'
            f"</form>"
        )

    def render_project_hide_form(self, item: dict[str, Any]) -> str:
        hidden = bool(item.get("hidden"))
        action = "unhide" if hidden else "hide"
        label = "Show" if hidden else "Hide"
        return (
            f'<form class="flag-form" method="post" action="/project/{esc(item["key"])}/flags/{action}" data-project-hide>'
            f'<input type="hidden" name="csrf" value="{esc(self.csrf_token)}">'
            f'<button class="flag-btn" type="submit" aria-pressed="{"true" if hidden else "false"}" aria-label="{label} {esc(item["short_name"])}">{label}</button>'
            f"</form>"
        )

    def render_project_flag_forms(self, item: dict[str, Any]) -> str:
        pin = "" if item.get("hidden") else self.render_project_pin_form(item)
        return f'<div class="project-card-flags">{pin}{self.render_project_hide_form(item)}</div>'

    def render_project_nav_item(self, item: dict[str, Any], project_key: str) -> str:
        selected_class = " is-selected" if project_key == item["key"] else ""
        pinned_class = " is-pinned" if item.get("pinned") else ""
        live_class = " is-live" if item.get("agents") and item.get("kind") == "workspace" else ""
        return (
            f'<div class="dock-item{pinned_class}" data-project-item data-project-key="{esc(item["key"])}" '
            f'data-filter-text="{esc(self.project_filter_text(item))}" data-pinned="{"1" if item.get("pinned") else "0"}">'
            f'<a class="dock-link{selected_class}" href="/project/{esc(item["key"])}" title="{esc(item["name"])}">'
            f'<span class="dock-glyph">{esc(monogram_text(item["short_name"]))}</span><span>{esc(item["short_name"])}</span>'
            f'<span class="dock-count{live_class}">{item["agents"]}</span></a>'
            f"{self.render_project_pin_form(item, compact=True)}</div>"
        )

    def render_project_strip(self, item: dict[str, Any]) -> str:
        error = (
            f'<span class="unavailable">{esc(item["error"])}</span>'
            if not item.get("available") and item.get("error")
            else ""
        )
        live = bool(item.get("agents")) and item.get("kind") == "workspace"
        agents_stat = (
            f'<span class="is-live"><span class="dot dot-ok"></span><b>{item["agents"]}</b> attached</span>'
            if live
            else f'<span><b>{item["agents"]}</b> agents</span>'
        )
        return (
            f'<article class="project-card" data-project-item data-project-key="{esc(item["key"])}" '
            f'data-filter-text="{esc(self.project_filter_text(item))}" data-pinned="{"1" if item.get("pinned") else "0"}">'
            f'<a class="project-card-main" href="/project/{esc(item["key"])}">'
            f'<span class="project-card-icon kind-{esc(item.get("kind") or "workspace")}" aria-hidden="true">{esc(monogram_text(item["short_name"]))}</span>'
            f'<span class="project-card-copy"><span class="project-card-name">{esc(item["name"])}</span>'
            f'<span class="project-card-path">{esc(item["path"])}</span></span>'
            f'<span class="project-card-stats">{agents_stat}<span><b>{item["messages"]}</b> messages</span></span>{error}</a>'
            f"{self.render_project_flag_forms(item)}</article>"
        )

    def render_project_bay(self, bay_id: str, title: str, items: list[dict[str, Any]], note: str = "") -> str:
        if not items and bay_id != "pinned":
            return ""
        if not items:
            rows = '<p class="bay-empty">Nothing pinned yet. Pin a project to keep it at the top of the register and the dock.</p>'
        else:
            rows = "".join(self.render_project_strip(item) for item in items)
        note_html = f'<span class="quiet">{esc(note)}</span>' if note else ""
        return (
            f'<section class="bay" data-project-bay="{esc(bay_id)}" aria-labelledby="{esc(bay_id)}-title">'
            f'<div class="bay-head"><h2 id="{esc(bay_id)}-title">{esc(title)}</h2><span class="bay-count">{len(items)}</span>'
            f"{note_html}</div>"
            f'<div class="bay-list">{rows}</div></section>'
        )

    def render_hidden_bay(self, items: list[dict[str, Any]]) -> str:
        if not items:
            return ""
        rows = "".join(self.render_project_strip(item) for item in items)
        return (
            f'<details class="bay" data-project-bay="hidden" data-hidden-bay>'
            f'<summary><span class="chev" aria-hidden="true">›</span><h2 id="hidden-title">Hidden</h2><span class="bay-count">{len(items)}</span>'
            f'<span class="quiet">Hidden projects stay out of the dock until you show them again.</span></summary>'
            f'<div class="bay-list">{rows}</div></details>'
        )

    def render_project_register(self) -> str:
        items = self.catalog()
        visible = [item for item in items if not item.get("hidden")]
        hidden = [item for item in items if item.get("hidden")]
        pinned = [item for item in visible if item.get("pinned")]
        sources = [item for item in visible if not item.get("pinned") and item.get("kind") != "workspace"]
        local = [item for item in visible if not item.get("pinned") and item.get("kind") == "workspace"]
        if hidden and not visible:
            empty = "Every project is hidden. Open Hidden below and choose Show to bring one back."
        else:
            empty = "No projects match that search."
        return f"""
          <section class="register" aria-label="Project register">
            <div class="register-toolbar">
              <label class="register-search">
                <span class="sr-only">Search projects</span>
                <input type="search" data-project-search placeholder="Search projects by name or path  ( / )" autocomplete="off" spellcheck="false">
                <span class="register-tally" aria-live="polite"><span data-project-count>{len(visible)}</span> of {len(items)}</span>
              </label>
            </div>
            <p class="register-empty" data-project-empty{" hidden" if visible else ""}>{esc(empty)}</p>
            {self.render_project_bay("pinned", "Pinned", pinned)}
            {self.render_project_bay("sources", "Coordination sources", sources, "Attached databases, not folders.")}
            {self.render_project_bay("local", "Local projects", local)}
            {self.render_hidden_bay(hidden)}
          </section>
        """

    # ---------- shell ----------

    def shell(self, title: str, body: str, project_key: str = "", active: str = "projects") -> str:
        summaries = self.catalog()
        visible = [item for item in summaries if not item.get("hidden")]
        project = self.projects.get(project_key)
        broker = self.broker_status()
        project_links = [self.render_project_nav_item(summary, project_key) for summary in visible]
        section_links = ""
        crumbs = '<a href="/">Projects</a>'
        if project is not None:
            summary = next(item for item in summaries if item["key"] == project.key)
            active_label = {"project": "Overview", "agents": "Agents", "messages": "Conversations"}.get(active, "Overview")
            crumbs = (
                f'<a href="/">Projects</a><span class="sep">/</span>'
                f'<a href="/project/{esc(project.key)}">{esc(project.short_name)}</a><span class="sep">/</span>'
                f"<strong>{esc(active_label)}</strong>"
            )
            live_class = " is-live" if summary["agents"] and project.kind == "workspace" else ""
            section_links = f"""
              <div class="dock-label">{esc(project.short_name)}</div>
              <a class="dock-link" href="/project/{esc(project.key)}"{' aria-current="page"' if active == 'project' else ''}>
                <span class="dock-glyph">O</span><span>Overview</span>
              </a>
              <a class="dock-link" href="/project/{esc(project.key)}/agents"{' aria-current="page"' if active == 'agents' else ''}>
                <span class="dock-glyph">A</span><span>Agents</span><span class="dock-count{live_class}">{summary['agents']}</span>
              </a>
              <a class="dock-link" href="/project/{esc(project.key)}/messages"{' aria-current="page"' if active == 'messages' else ''}>
                <span class="dock-glyph">C</span><span>Conversations</span><span class="dock-count">{summary['messages']}</span>
              </a>
            """
        elif active == "setup":
            crumbs = '<a href="/">Projects</a><span class="sep">/</span><strong>Local setup</strong>'
        project_list = "".join(project_links) or '<p class="dock-empty">No visible projects. Use Hidden on the projects page to show one.</p>'
        return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>{esc(title)} — Agent Bus</title>
  <script src="/assets/theme.js?v=switchboard-2"></script>
  <link rel="stylesheet" href="/assets/dashboard.css?v=switchboard-2">
  <script src="/assets/dashboard.js?v=switchboard-2" defer></script>
</head>
<body data-project="{esc(project_key)}" data-view="{esc(active)}">
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="topbar">
    <button class="dock-toggle" type="button" data-nav-toggle aria-expanded="true" aria-controls="sidebar-scroll" aria-label="Hide project dock" title="Hide project dock">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14"/></svg>
    </button>
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true"><img src="/assets/b-logo.png?v=cat" alt=""></span>
      <span class="brand-name">Agent Bus</span>
    </a>
    <nav class="crumbs" aria-label="Breadcrumb">{crumbs}</nav>
    <span class="topbar-spacer"></span>
    {self.render_live_pill(broker)}
    <div class="theme-switch" role="group" aria-label="Theme">
      <button type="button" data-theme-set="light" aria-pressed="true">Light</button>
      <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
      <button type="button" data-theme-set="evil" aria-pressed="false">Evil</button>
    </div>
    <a class="topbar-link" href="/setup"{' aria-current="page"' if active == 'setup' else ''}>Local setup</a>
  </header>
  <div class="frame">
    <aside class="dock" id="sidebar" aria-label="Project dock">
      <div class="dock-scroll" id="sidebar-scroll">
        <label class="dock-search">
          <span class="sr-only">Search projects</span>
          <input type="search" data-project-search placeholder="Search projects" autocomplete="off" spellcheck="false">
        </label>
        <a class="dock-link" href="/"{' aria-current="page"' if active == 'projects' else ''}>
          <span class="dock-glyph">P</span><span>All projects</span><span class="dock-count">{len(visible)}</span>
        </a>
        <details class="dock-group" data-project-menu open>
          <summary><span><span class="chev" aria-hidden="true">›</span> Projects</span><span class="dock-count">{len(visible)}</span></summary>
          <div class="dock-list">{project_list}</div>
        </details>
        {section_links}
      </div>
      <div class="dock-foot sidebar-foot"><a href="/setup">Local setup</a><span>Runs on this machine</span></div>
    </aside>
    <div class="dock-scrim" data-dock-scrim></div>
    <main class="main" id="content" tabindex="-1"><div class="content">{body}</div></main>
  </div>
</body>
</html>"""

    # ---------- setup ----------

    def setup_notice(self) -> str:
        if not self.settings:
            return '<p class="setup-hint"><a href="/setup">Local setup</a></p>'
        local_count = sum(project.kind == "workspace" for project in self.projects.values())
        if not local_count:
            return (
                '<section class="setup-card"><div><h2>Set up this machine</h2>'
                "<p>Choose a projects folder, then open a project to see its agents and conversations. "
                "Coordinator and AgentBus history are optional.</p></div>"
                '<a class="btn btn-primary" href="/setup">Choose projects folder</a></section>'
            )
        return ""

    def setup_page(self, query: dict[str, list[str]], values: dict[str, str] | None = None, error: str = "") -> str:
        settings = self.settings
        if settings is None:
            return self.shell("Local setup", '<h1>Local setup</h1><p class="lede">Start the dashboard with scripts/run_dashboard.sh.</p>', active="setup")
        values = values or {}
        saved = read_config(settings.config)
        fields = []
        for key, (label, helper) in CONFIG_FIELDS.items():
            target = getattr(settings, key)
            explicit = key in saved or "AGENT_DASHBOARD_" + key.upper() in os.environ or any(arg.startswith("--" + key.replace("_", "-")) for arg in settings.launch_argv)
            value = values.get(key, str(target) if target is not None and (target.exists() or explicit) else "")
            fields.append(
                f'<label class="setup-field" for="setup-{key}"><span>{esc(label)}</span>'
                f'<input id="setup-{key}" aria-label="{esc(label)}" name="{key}" value="{esc(value)}" placeholder="Not configured" spellcheck="false">'
                f"<small>{esc(helper)}</small></label>"
            )
        roots = values.get("projects_root", "\n".join(str(root) for root in settings.projects_root))
        cards = []
        for key, name, hint in (
            ("coordinator_db", "Coordinator", "Agents, tasks, review state, and messages from the coordinator database."),
            ("agent_bus_db", "AgentBus history", "Messages from the optional AgentBus SQLite store."),
        ):
            project = self.projects.get("coordinator" if key == "coordinator_db" else "liminal")
            summary = project.summary() if project else None
            if summary and summary["available"]:
                state, klass = "Connected", "working"
            elif summary:
                state, klass = "Cannot read source", "failed"
            elif saved.get(key) and getattr(settings, key):
                state, klass = "File unavailable", "blocked"
                hint = f"{hint} The saved path does not resolve to a readable file; review it under Optional sources below."
            else:
                state, klass = "Not configured", "idle"
            cards.append(f'<div class="conn-card"><strong>{name}</strong>{self.status_pill_named(state, klass)}<p>{esc(hint)}</p></div>')
        probe = ProjectSource("setup", "Setup", "Setup", "", "", "workspace", bus_url=settings.live_bus_url)
        snapshot = probe._live_snapshot()
        reachable = snapshot.get("_reachable", True) is not False
        broker_state = "Connected" if reachable else "Disconnected"
        broker_hint = (
            f"{settings.live_bus_url}. Agents belong to a project when their workdir matches its folder exactly."
            if reachable
            else f"{settings.live_bus_url} is not answering. Start your existing AgentBus broker, then reload."
        )
        cards.append(
            f'<div class="conn-card"><strong>Live broker</strong>{self.status_pill_named(broker_state, "working" if reachable else "failed")}'
            f"<p>{esc(broker_hint)}</p></div>"
        )
        local_count = sum(project.kind == "workspace" for project in self.projects.values())
        cards.append(
            f'<div class="conn-card"><strong>Local projects</strong>{self.status_pill_named(f"{local_count} discovered", "active" if local_count else "idle")}'
            f"<p>{esc(', '.join(str(root) for root in settings.projects_root))}</p></div>"
        )
        if error:
            notice = f'<div class="flash flash-error" role="alert"><div><strong>Setup was not saved</strong>{esc(error)}</div></div>'
        elif query.get("saved"):
            notice = '<div class="flash flash-success" role="status"><div>Setup saved. Open a project to continue.</div></div>'
        else:
            notice = ""
        return self.shell(
            "Local setup",
            f"""
          <header class="page-head"><div><p class="kicker">This machine</p><h1>Local setup</h1><p class="lede">Point the dashboard at your projects and existing services. Everything stays on this machine; nothing here starts an agent.</p></div><a class="text-link" href="/">Open projects →</a></header>
          {notice}
          <section class="connections" aria-label="Connection status">{''.join(cards)}</section>
          <form class="setup-form" method="post" action="/setup">
            <input type="hidden" name="csrf" value="{esc(self.csrf_token)}">
            <label class="setup-field" for="projects-root"><span>Projects folder</span><textarea id="projects-root" aria-label="Projects folder" name="projects_root" rows="2" required spellcheck="false" aria-describedby="roots-help">{esc(roots)}</textarea><small id="roots-help">Use ~/Projects or an existing absolute folder path. One root per line. Immediate folders and nested repositories appear in the register.</small></label>
            <label class="setup-field" for="broker-url"><span>Live AgentBus broker</span><input id="broker-url" aria-label="Live AgentBus broker" name="live_bus_url" value="{esc(values.get('live_bus_url', settings.live_bus_url))}" required spellcheck="false"><small>Default: http://127.0.0.1:7717. Loopback only.</small></label>
            <details class="setup-sources"><summary>Optional sources and agent controls</summary><div class="setup-sources-body"><p>Use paths from your existing installations. Leave unused sources blank. This dashboard does not install or start coordination services.</p>{''.join(fields)}</div></details>
            <div class="setup-save"><button class="btn btn-primary" type="submit">Save local setup</button><span>Applies immediately; no supervisor restart.</span></div>
          </form>
          <p class="config-location">Saved in <code>{esc(settings.config)}</code>. Command-line flags override environment variables, which override this file. Edit those overrides at launch if a saved value does not change.</p>
          <section class="setup-next"><h2>Next: open a project</h2><p>Use <a href="/">Projects</a> to choose a folder, then Agents to check attached identities, usage, and tasks. Conversations contains Inbox, Archived, and Trash; restoring a conversation returns it to Inbox without changing source history.</p></section>
        """,
            active="setup",
        )

    @staticmethod
    def status_pill_named(label: str, klass: str) -> str:
        return f'<span class="status-pill status-{esc(klass)}"><span class="dot"></span>{esc(label)}</span>'

    # ---------- home ----------

    def home(self, query: dict[str, list[str]] | None = None) -> str:
        broker = self.broker_status()
        items = self.catalog()
        visible = [item for item in items if not item.get("hidden")]
        live_projects = [item for item in visible if item.get("kind") == "workspace" and item.get("agents")]
        total_live = sum(int(item.get("agents") or 0) for item in live_projects)
        live_chip = (
            f'<span class="summary-chip"><span class="dot dot-ok"></span><b>{total_live}</b> agent{"s" if total_live != 1 else ""} attached in <b>{len(live_projects)}</b> project{"s" if len(live_projects) != 1 else ""}</span>'
            if total_live
            else '<span class="summary-chip"><span class="dot is-ring"></span>No agents attached in visible projects</span>'
        )
        body = f"""
          {self.flash(query or {})}
          <header class="page-head"><div><p class="kicker">Switchboard</p><h1>Choose a project</h1><p class="lede">Every folder under your projects roots, plus the coordination sources you attached. Open one to see its agents, tasks, and conversations.</p></div>
          <div class="home-summary"><span class="summary-chip"><b>{len(visible)}</b> visible · <b>{len(items) - len(visible)}</b> hidden</span>{live_chip}</div></header>
          {self.setup_notice()}
          {self.render_project_register()}
          {self.render_mascot()}
        """
        return self.shell("Projects", body)

    # ---------- project overview ----------

    def project_page(self, project: ProjectSource) -> str:
        summary = project.summary()
        if not summary["available"]:
            return self.error_page(project, summary["error"])
        try:
            snapshot = project._live_snapshot() if project.kind == "workspace" else None
            agents = self.apply_saved_agent_roles(project, project.listed_agents(snapshot))
            messages = project.messages()
            tasks = project.tasks(snapshot)
        except (OSError, sqlite3.Error, ValueError) as error:
            return self.error_page(project, str(error))
        conversations = group_conversations(messages)
        for conversation in conversations:
            conversation["status"] = self.state_store.status(project.key, conversation["id"])
        inbox = [item for item in conversations if item["status"] == "inbox"]
        live_agents = [agent for agent in agents if agent.get("listed") not in {"registered", "session"}]
        registered = [agent for agent in agents if agent.get("listed") == "registered"]
        open_tasks = [task for task in tasks if clean_text(task.get("state")).lower() in TASK_OPEN_STATES]
        reachable = snapshot is None or snapshot.get("_reachable", True) is not False
        if project.kind == "workspace":
            controllable = sum(1 for agent in live_agents if agent.get("controllable"))
            agents_sub = f"{controllable} controllable · {len(registered)} registered, not attached" if live_agents or registered else "Attach a supervisor to this folder"
            source_value = "Connected" if reachable else "Disconnected"
            source_sub = "Live AgentBus broker" if reachable else "Showing last-known values"
            source_class = "is-ok" if reachable else "is-crit"
        else:
            working = sum(1 for agent in live_agents if clean_text(agent.get("status")).lower() == "working")
            agents_sub = f"{working} working now"
            source_value = "Readable"
            source_sub = self.kind_label(project.kind)
            source_class = "is-ok"
        stats = f"""
          <section class="stat-row" aria-label="Project summary">
            <div class="stat"><span class="stat-label">Attached agents</span><span class="stat-value">{'<span class="dot dot-ok"></span>' if live_agents else ''}{len(live_agents)}</span><span class="stat-sub">{esc(agents_sub)}</span></div>
            <div class="stat"><span class="stat-label">Inbox conversations</span><span class="stat-value">{len(inbox)}</span><span class="stat-sub">{len(messages)} messages · {len(conversations)} conversations total</span></div>
            <div class="stat"><span class="stat-label">Open tasks</span><span class="stat-value">{len(open_tasks)}</span><span class="stat-sub">{len(tasks)} tracked</span></div>
            <div class="stat"><span class="stat-label">Source</span><span class="stat-value is-text">{esc(source_value)}</span><span class="stat-sub {source_class}">{esc(source_sub)}</span></div>
          </section>
        """
        index = self.agent_index(agents)
        if live_agents:
            chips = []
            for agent in live_agents[:8]:
                detail = " · ".join(part for part in (agent_model_line(agent), clean_text(agent.get("doing"))) if part)
                chips.append(
                    f'<a class="agent-chip" href="/project/{esc(project.key)}/agents" title="{esc(agent.get("id"))}">{avatar_html(agent)}'
                    f'<span class="agent-chip-copy"><strong>{esc(agent_title(agent))}</strong><span>{esc(detail)}</span></span>'
                    f'{self.status_pill(agent.get("status"))}</a>'
                )
            more = f'<p class="panel-foot">{len(live_agents) - 8} more on the Agents page</p>' if len(live_agents) > 8 else ""
            roster = f'<div class="roster-mini">{"".join(chips)}</div>{more}'
        else:
            copy = (
                "Connect an existing AgentBus supervisor using this project’s exact folder as its workdir."
                if project.kind == "workspace"
                else "This source has no agents recorded."
            )
            roster = self.empty_state("No agents attached", copy, f'<a class="btn btn-small" href="/project/{esc(project.key)}/agents">Open Agents</a>', compact=True)
        overview = f"""
          <div class="grid-2">
            <section class="panel" aria-labelledby="overview-agents"><div class="panel-head"><div><h2 id="overview-agents">Agents</h2><p>Live status, supervision, usage, and roles.</p></div><a class="text-link" href="/project/{esc(project.key)}/agents">Manage agents →</a></div>{roster}</section>
            <section class="panel" aria-labelledby="overview-conversations"><div class="panel-head"><div><h2 id="overview-conversations">Recent conversations</h2><p>Inbox only. Archive and Trash are on the Conversations page.</p></div><a class="text-link" href="/project/{esc(project.key)}/messages">View all →</a></div>{self.render_conversation_teasers(project, inbox[:5], index)}</section>
          </div>
          {self.render_tasks_panel(project, tasks, limit=6, index=index)}
        """
        body = f"""
          <header class="page-head"><div><p class="kicker">{esc(self.kind_label(project.kind))}</p><h1>{esc(project.name)}</h1><p class="lede">{esc(project.description)}</p></div>
          <div class="page-side"><span class="tag tag-kind-{esc(project.kind)}">{esc(self.kind_label(project.kind))}</span><span class="path-chip" title="{esc(project.path_label)}">{esc(project.path_label)}</span></div></header>
          {self.hidden_notice(project)}
          {stats}
          {overview}
        """
        return self.shell(project.name, body, project.key, "project")

    # ---------- agents ----------

    def render_agent_rows(self, project: ProjectSource, agents: list[dict[str, Any]], include_usage: bool) -> str:
        rows = []
        for agent in agents:
            filter_text = clean_text(
                " ".join(
                    str(agent.get(key, ""))
                    for key in ("id", "name", "role", "model", "status", "doing", "auth", "role_effect_label", "session_id", "harness", "cli", "description")
                )
            ).lower()
            actions = []
            if project.kind == "workspace" and agent.get("session_available"):
                actions.append(f"""<form class="inline-form" method="post" action="/project/{esc(project.key)}/agents/open-session">
                  <input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><input type="hidden" name="agent_id" value="{esc(agent.get('id'))}"><button class="btn btn-small" type="submit">{esc(agent.get('session_label') or 'Open latest session')}</button></form>""")
            if project.kind == "workspace" and agent.get("controllable"):
                actions.append(f"""<form class="inline-form" method="post" action="/project/{esc(project.key)}/agents/stop" data-confirm="Stop {esc(agent_title(agent))} ({esc(agent.get('id'))}) and its running child process?">
                  <input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><input type="hidden" name="agent_id" value="{esc(agent.get('id'))}"><button class="btn btn-danger btn-small" type="submit">Stop</button></form>""")
            if actions:
                action = f'<div class="control-stack">{"".join(actions)}</div>'
            elif agent.get("listed") == "registered":
                action = '<span class="agent-actions-none">Start from Supervision</span>'
            else:
                action = '<span class="agent-actions-none">No controls</span>'
            row_attrs = ""
            if project.kind == "workspace" and agent.get("listed") == "live":
                control_signature = f"{int(bool(agent.get('session_available')))}|{int(bool(agent.get('controllable')))}"
                row_attrs = f' data-agent-id="{esc(agent.get("id"))}" data-agent-control-signature="{control_signature}"'
            harness = infer_harness(agent)
            model = clean_text(agent.get("model"))
            model_line = agent_model_line(agent, with_provider=True)
            auth = clean_text(agent.get("auth")) if project.kind == "workspace" else ""
            harness_cell = self.cell(
                "Harness · model",
                f'{self.harness_chip(harness) if harness and harness != "human" else ""}<span class="model" title="{esc(model)}">{esc(model_line)}</span>'
                + (f'<span class="auth">{esc(auth)}</span>' if auth else ""),
                "agent-harness",
            )
            usage_cell = ""
            if include_usage:
                usage = usage_values(agent.get("usage"))
                usage_cell = self.cell(
                    "Usage",
                    f"""<div class="agent-usage">
                  <strong data-agent-usage="tokens">{format_count(usage['tokens'])} tokens</strong>
                  <span data-agent-usage="turns">{format_count(usage['turns'])} turns</span>
                  <span data-agent-usage="cost">{format_cost(usage['costUSD'])} equivalent</span>
                  <small>Current broker session</small>
                </div>""",
                    "agent-usage-cell",
                )
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
            session_id = clean_text(agent.get("session_id"))
            ident_rows = [f'<span class="ident-key">Agent ID</span><code class="ident-value">{esc(agent.get("id"))}</code>']
            if session_id:
                ident_rows.append(f'<span class="ident-key">Session</span><code class="ident-value">{esc(session_id)}</code>')
            if model:
                ident_rows.append(f'<span class="ident-key">Model ID</span><code class="ident-value">{esc(model)}</code>')
            ident_note = (
                f'<details class="agent-ident"><summary>Identifiers</summary><dl class="ident-list">{"".join(ident_rows)}</dl></details>'
            )
            description = clean_text(agent.get("description"))
            desc_note = f'<span class="agent-desc">{esc(description)}</span>' if description else ""
            flags = []
            if agent.get("listed") == "live" and agent.get("in_registry"):
                flags.append('<span class="flag">Registered identity</span>')
            if agent.get("stalled"):
                flags.append('<span class="flag flag-serious">Stalled</span>')
            if agent.get("blocked"):
                flags.append('<span class="flag flag-accent">Idle in bus_wait</span>')
            pending = int(agent.get("pending_messages") or 0)
            flags.append(
                f'<span class="flag flag-warn" data-agent-pending{" hidden" if not pending else ""}>{pending} pending message{"s" if pending != 1 else ""}</span>'
            )
            parent = clean_text(agent.get("parent_id"))
            if parent:
                flags.append(f'<span class="flag">Reports to {esc(parent)}</span>')
            capabilities = agent.get("capabilities") if isinstance(agent.get("capabilities"), list) else []
            for capability in capabilities[:4]:
                flags.append(f'<span class="flag">{esc(capability)}</span>')
            supervisor = agent.get("supervisor_pid")
            if supervisor:
                flags.append(f'<span class="flag">supervisor pid {esc(supervisor)}</span>')
            identity = (
                f'<div class="agent-identity">{avatar_html(agent)}'
                f'<div class="agent-identity-copy"><span class="agent-name" title="{esc(agent.get("id"))}">{esc(agent_title(agent))}</span>'
                f'<span class="agent-model-line">{esc(agent_model_line(agent))}</span>{desc_note}{ident_note}</div></div>'
            )
            status_cell = self.cell(
                "Status",
                f'<div class="agent-status">{self.status_pill(agent.get("status"), hook=True)}'
                f'<small>seen <span data-agent-seen>{esc(display_time(agent.get("last_active")))}</span></small></div>',
                "agent-status-cell",
            )
            activity_cell = self.cell(
                "Activity",
                f'<div class="agent-activity"><span data-agent-doing>{esc(agent.get("doing") or "No activity reported")}</span>'
                f'<div class="agent-flags">{"".join(flags)}</div></div>',
                "agent-activity-cell",
            )
            role_cell = self.cell("Role", role_control, "agent-role")
            actions_cell = self.cell("Controls", f'<div class="agent-actions">{action}</div>', "agent-actions-cell")
            row_class = "agent-row" if include_usage else "agent-row no-usage"
            rows.append(
                f'<div class="{row_class}" data-filter-text="{esc(filter_text)}"{row_attrs}>'
                f"{identity}{status_cell}{harness_cell}{activity_cell}{usage_cell}{role_cell}{actions_cell}</div>"
            )
        return f'<div class="roster-list">{"".join(rows)}</div>'

    def render_supervision(self, project: ProjectSource, live_agents: list[dict[str, Any]], registered_count: int, snapshot: dict[str, Any] | None) -> str:
        active_ids = project.attached_agent_ids()
        definitions = [item for item in project.agent_definitions() if item["id"] not in active_ids]
        options = "".join(
            f'<option value="{esc(item["id"])}">{esc(agent_title(item))} · {esc(model_display(item["model"]) or harness_label(harness_key(item["harness"])) or "Unknown model")}</option>' for item in definitions
        )
        reachable = snapshot is None or snapshot.get("_reachable", True) is not False
        select_disabled = "" if options and reachable else " disabled"
        controllable_count = sum(1 for agent in live_agents if agent.get("controllable"))
        waiting_count = sum(1 for agent in live_agents if clean_text(agent.get("status")).lower() == "waiting")
        working_count = sum(1 for agent in live_agents if clean_text(agent.get("status")).lower() == "working")
        stalled_count = sum(1 for agent in live_agents if agent.get("stalled"))
        online_count = sum(
            1 for agent in live_agents if clean_text(agent.get("status")).lower() not in {"offline", "stale", "unregistered", "failed"}
        )
        stop_disabled = "" if controllable_count and reachable else " disabled"
        if not reachable:
            note = "The broker is unreachable, so start and stop are disabled and the roster shows last-known values marked stale."
        elif not options and not live_agents:
            note = "No registered AgentBus identities are available to start. Check the implementation folder in Local setup."
        elif not options:
            note = "Every registered identity is already attached. Stop one to free it."
        else:
            note = "Start launches an existing supervisor with this folder as its workdir. Stop sends a graceful termination request."
        counts = "".join(
            f'<div class="count-item"><span>{label}</span><strong>{dot}{value}</strong></div>'
            for label, value, dot in (
                ("Attached", len(live_agents), ""),
                ("Online", online_count, '<span class="dot dot-ok"></span>' if online_count else '<span class="dot is-ring"></span>'),
                ("Working", working_count, ""),
                ("Waiting", waiting_count, ""),
                ("Stalled", stalled_count, '<span class="dot dot-serious"></span>' if stalled_count else ""),
                ("Controllable", controllable_count, ""),
                ("Registered", registered_count, ""),
            )
        )
        return f"""
          <section class="panel" aria-labelledby="control-title">
            <div class="panel-head"><div><h2 id="control-title">Supervision</h2><p>Start a registered supervisor in this folder, or stop the ones the broker can control.</p></div>{self.status_pill_named("Broker connected" if reachable else "Broker disconnected", "working" if reachable else "failed")}</div>
            <div class="supervision-grid">
              <div><div class="counts">{counts}</div><p class="supervision-note">{esc(note)}</p></div>
              <div class="control-actions">
                <form class="agent-control-form" method="post" action="/project/{esc(project.key)}/agents/start"><input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><label for="agent-id">Registered agent</label><div class="field-row"><select id="agent-id" name="agent_id" required{select_disabled}><option value="" selected disabled>{'Choose an agent…' if options else 'No registered agents available — check Local setup'}</option>{options}</select><button class="btn btn-primary" type="submit"{select_disabled}>Start agent</button></div></form>
                <div class="stop-all-row"><span>Stops every controllable supervisor in this project.</span><form class="inline-form" method="post" action="/project/{esc(project.key)}/agents/stop-all" data-confirm="Stop all {controllable_count} controllable supervisors in this project?"><input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><button class="btn btn-danger" type="submit"{stop_disabled}>Stop all</button></form></div>
              </div>
            </div>
          </section>
        """

    def render_tasks_panel(
        self,
        project: ProjectSource,
        tasks: list[dict[str, Any]],
        limit: int | None = None,
        index: dict[str, dict[str, Any]] | None = None,
    ) -> str:
        if project.kind == "agent-bus":
            return ""
        index = index or {}
        shown = tasks if limit is None else tasks[:limit]
        if project.kind == "workspace":
            subtitle = "Live broker tasks assigned to or by agents attached here. Read-only; resets when the broker restarts."
            empty_copy = "No tasks in the current broker session touch this project’s agents."
        else:
            subtitle = "Tasks recorded in the coordinator database. Read-only."
            empty_copy = "The coordinator has no tasks recorded."
        if shown:
            rows = []
            for task in shown:
                who = ""
                if task.get("assigner") or task.get("assignee"):
                    assigner = self.who_label(index, task["assigner"]) if task.get("assigner") else "—"
                    assignee = self.who_label(index, task["assignee"]) if task.get("assignee") else "unassigned"
                    who = f'{assigner} <span class="arrow">→</span> {assignee}'
                if task.get("round") is not None:
                    tries = f' · {task["attempts"]}/{task["max_retries"]} tries' if task.get("max_retries") else ""
                    round_text = f'round {task["round"]}{tries}'
                else:
                    round_text = f'priority {task.get("priority") or "normal"}'
                brief_html = f'<span>{esc(task["brief"])}</span>' if task.get("brief") else ""
                rows.append(
                    f'<div class="task-row">{self.status_pill_named(task_state_label(task.get("state")), task_state_class(task.get("state")))}'
                    f'<div class="task-copy"><strong>{esc(task["title"])}</strong>{brief_html}</div>'
                    f'<div class="task-people">{who}</div><span class="task-round">{esc(round_text)}</span><time>{esc(task["updated"])}</time></div>'
                )
            body = f'<div class="task-list">{"".join(rows)}</div>'
        else:
            body = self.empty_state("No tasks", empty_copy, compact=True)
        counts: dict[str, int] = {}
        for task in tasks:
            key = task_state_label(task.get("state"))
            counts[key] = counts.get(key, 0) + 1
        summary = "".join(f'<span class="flag">{esc(label)} {count}</span>' for label, count in sorted(counts.items()))
        if not summary:
            summary = f'<span class="panel-meta">{len(tasks)} tasks</span>'
        foot = f'<div class="panel-foot"><span>Showing {len(shown)} of {len(tasks)}</span><a class="text-link" href="/project/{esc(project.key)}/agents#tasks">All tasks →</a></div>' if limit is not None and len(tasks) > len(shown) else ""
        return f"""
          <section class="panel" id="tasks" aria-labelledby="tasks-title">
            <div class="panel-head"><div><h2 id="tasks-title">Tasks</h2><p>{esc(subtitle)}</p></div><div class="task-summary">{summary}</div></div>
            {body}{foot}
          </section>
        """

    def agents_page(self, project: ProjectSource, query: dict[str, list[str]] | None = None) -> str:
        query = query or {}
        live_snapshot: dict[str, Any] | None = None
        try:
            if project.kind == "workspace":
                live_snapshot = project._live_snapshot()
                agents = self.apply_saved_agent_roles(project, project.listed_agents(live_snapshot))
            else:
                agents = self.apply_saved_agent_roles(project, project.listed_agents())
            tasks = project.tasks(live_snapshot)
        except (OSError, sqlite3.Error, ValueError) as error:
            return self.error_page(project, str(error), "agents")
        flash = self.flash(query)
        live_agents = [agent for agent in agents if agent.get("listed") not in {"registered", "session"}]
        registered_agents = [agent for agent in agents if agent.get("listed") == "registered"]
        include_usage = project.kind == "workspace"
        if live_agents:
            live_table = self.render_agent_rows(project, live_agents, include_usage)
        else:
            copy = (
                "Connect an existing AgentBus supervisor using this project’s exact folder as its workdir. "
                "Registered supervisors appear below and can be started from Supervision. <a href=\"/setup\">Check local setup</a>."
                if project.kind == "workspace"
                else "This source has no agents recorded yet."
            )
            live_table = self.empty_state("No agents attached", copy)
        registered_section = ""
        if registered_agents:
            registered_table = self.render_agent_rows(project, registered_agents, include_usage=False)
            registered_section = f'<section class="panel" aria-label="Registered AgentBus agents"><div class="panel-head"><div><h2>Registered AgentBus agents</h2><p>Identities in agents.json that are not attached to this folder right now.</p></div><span class="panel-meta">{len(registered_agents)} identities</span></div>{registered_table}</section>'
        controls = ""
        usage_monitor = ""
        if project.kind == "workspace":
            controls = self.render_supervision(project, live_agents, len(registered_agents), live_snapshot)
            live_reachable = live_snapshot is None or live_snapshot.get("_reachable", True) is not False
            last_observed = "" if live_snapshot is None else clean_text(live_snapshot.get("_observedAt"))
            usage_monitor = self.render_usage_monitor(project, live_agents, live_reachable, last_observed)
        lede = (
            "Live status, harness and model, current activity, usage, and saved roles for every identity attached to this folder."
            if project.kind == "workspace"
            else "Agents recorded by this source, with their saved roles. Supervision and usage are available for live AgentBus workspaces only."
        )
        body = f"""
          <header class="page-head"><div><p class="kicker">{esc(project.short_name)}</p><h1>Agents</h1><p class="lede">{lede}</p></div>
          <div class="page-side"><a class="btn btn-quiet" href="/project/{esc(project.key)}/agents">Refresh</a><a class="text-link" href="/project/{esc(project.key)}/messages">Conversations →</a></div></header>
          {self.hidden_notice(project)}{flash}{controls}
          {usage_monitor}
          {self.role_presets_datalist()}
          <section class="panel" aria-label="Agent list" id="roster">
            <div class="panel-head"><div><h2>Attached agents</h2><p>{len(live_agents)} observed · search filters every column</p></div>
            <div class="panel-tools"><span class="panel-meta" data-filter-count aria-live="polite"></span><div class="search"><input data-search type="search" aria-label="Filter agents" placeholder="Filter agents ( / )"></div></div></div>
            {live_table}
            <p class="register-empty" data-filter-empty hidden>No agents match that filter.</p>
          </section>
          {registered_section}
          {self.render_tasks_panel(project, tasks, index=self.agent_index(agents))}
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
        total_tokens = sum(int(group["tokens"]) for group in summary["subscriptions"]) or 0
        subscription_rows = []
        for group in summary["subscriptions"]:
            fraction = (int(group["tokens"]) / total_tokens) if total_tokens else 0.0
            subscription_rows.append(
                f"""<div class="usage-row">
                  <div class="usage-name"><strong>{esc(group['name'])}</strong><span title="{esc(', '.join(group['agents']))}">{esc(', '.join(group.get('labels') or group['agents']))}</span></div>
                  <div class="usage-share"><meter min="0" max="1" value="{fraction:.4f}" aria-label="Share of tokens"></meter><small>{round(fraction * 100)}%</small></div>
                  <span class="num">{format_count(group['turns'])}</span><span class="num">{format_count(group['tokens'])}</span><span class="num">{format_cost(group['costUSD'])}</span>
                </div>"""
            )
        if not subscription_rows:
            subscription_rows.append('<div class="usage-empty">Usage appears after an attached agent completes a turn.</div>')
        if reachable:
            monitor_status = "Live · updates every 10s"
        elif last_observed:
            monitor_status = f"Update paused · last confirmed {display_time(last_observed)}"
        else:
            monitor_status = "Broker unavailable · retrying"
        return f"""
          <section class="panel usage-panel" aria-labelledby="usage-title" data-usage-monitor data-api-url="/project/{esc(project.key)}/api/agents">
            <div class="panel-head"><div><h2 id="usage-title">Usage</h2><p>Current broker session · resets when AgentBus restarts · equivalent cost is an estimate, not a charge</p></div><span class="panel-meta usage-status" data-usage-status aria-live="polite">{esc(monitor_status)}</span></div>
            <div class="usage-tiles">
              <div><span>Turns</span><strong data-usage-total="turns">{format_count(total['turns'])}</strong></div>
              <div><span>Tokens</span><strong data-usage-total="tokens">{format_count(total['tokens'])}</strong></div>
              <div><span>Equivalent cost</span><strong data-usage-total="cost">{format_cost(total['costUSD'])}</strong><small>Estimate, not a subscription charge</small></div>
            </div>
            <div class="usage-head" aria-hidden="true"><span>Subscription</span><span>Share of tokens</span><span>Turns</span><span>Tokens</span><span>Equivalent cost</span></div>
            <div data-usage-subscriptions>{''.join(subscription_rows)}</div>
          </section>
        """

    # ---------- conversations ----------

    def messages_page(self, project: ProjectSource, query: dict[str, list[str]]) -> str:
        try:
            messages = project.messages()
            agents = project.agents()
        except (OSError, sqlite3.Error, ValueError) as error:
            return self.error_page(project, str(error), "messages")
        harness_map = {str(agent.get("id")): infer_harness(agent) for agent in agents if agent.get("id")}
        try:
            index = self.agent_index(self.apply_saved_agent_roles(project, project.listed_agents()))
        except (OSError, sqlite3.Error, ValueError):
            index = self.agent_index(agents)
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
                f'<a class="folder-tab" href="/project/{esc(project.key)}/messages?box={name}"{current}>{label}<span>{counts[name]}</span></a>'
            )
        tabs = "".join(tabs_list)
        list_html = self.render_conversation_list(project, visible, box, selected["id"] if selected else "", page, search_query, harness_map, index)
        detail_html = self.render_conversation_detail(project, selected, box, harness_map, index)
        pagination = self.render_pagination(project, box, page, page_count, search_query)
        compose = self.render_compose(project, agents)
        found = f"{len(filtered)} found" if search_query else f"{len(filtered)} in {box.title()}"
        body = f"""
          <header class="page-head"><div><p class="kicker">{esc(project.short_name)}</p><h1>Conversations</h1><p class="lede">{len(messages)} messages grouped into {len(conversations)} conversations. Archive and Trash only change this dashboard; source history stays intact. Conversation roles are operator metadata.</p></div>
          <div class="page-side"><a class="text-link" href="/project/{esc(project.key)}/agents">Manage agents →</a></div></header>
          {self.hidden_notice(project)}{self.flash(query)}
          {self.role_presets_datalist()}
          <div class="conv-toolbar">
            <nav class="folders" aria-label="Conversation folders">{tabs}</nav>
            <form class="conv-search" method="get" action="/project/{esc(project.key)}/messages"><input type="hidden" name="box" value="{esc(box)}"><input data-search name="q" value="{esc(search_query)}" type="search" aria-label="Search all conversations" placeholder="Search conversations"><button class="btn btn-small" type="submit">Search</button><span>{esc(found)}</span></form>
          </div>
          <section class="workspace" aria-label="{esc(box.title())} conversations">
            <aside class="index" aria-label="Conversation index">{list_html}{pagination}</aside>
            <article class="detail" id="conversation-detail" tabindex="-1">{detail_html}{compose}</article>
          </section>
        """
        return self.shell(f"{project.name} conversations", body, project.key, "messages")

    def render_conversation_list(
        self,
        project: ProjectSource,
        conversations: list[dict[str, Any]],
        box: str,
        selected_id: str,
        page: int,
        search_query: str,
        harness_map: dict[str, str] | None = None,
        index: dict[str, dict[str, Any]] | None = None,
    ) -> str:
        harness_map = harness_map or {}
        index = index or {}
        if not conversations:
            if box == "archived":
                copy = "Archived conversations appear here. Archive keeps them out of the Inbox without touching source history."
            elif box == "trash":
                copy = "Deleted conversations stay here until you restore them."
            elif search_query:
                copy = "Nothing matches that search in this folder."
            else:
                copy = "Messages appear when agents are attached to this project’s exact folder. Check <a href=\"agents\">Agents</a> or <a href=\"/setup\">Local setup</a> to connect your existing services."
            return f'<div class="conv-list">{self.empty_state(f"{box.title()} is empty", copy, compact=True)}</div>'
        rows = []
        for conversation in conversations:
            actions = self.conversation_actions(project, conversation["id"], box, compact=True)
            participants = self.who_names(index, conversation["participants"])
            raw_participants = ", ".join(conversation["participants"])
            filter_text = clean_text(f"{conversation['title']} {participants} {raw_participants} {conversation['latest_body']}").lower()
            selected_class = " is-selected" if conversation["id"] == selected_id else ""
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
            role_note = f'<span class="conv-role-chip">{esc(conversation_role)}</span>' if conversation_role else ""
            latest_sender = conversation.get("latest_sender") or (conversation["participants"][0] if conversation["participants"] else "?")
            rows.append(f"""
              <div class="conv-row{selected_class}" data-filter-text="{esc(filter_text + ' ' + conversation_role)}">
                <a class="conv-link" href="/project/{esc(project.key)}/messages?{esc(link_query)}#conversation-detail"{' aria-current="true"' if selected_class else ''}>{avatar_html(self.who(index, latest_sender), harness=harness_map.get(str(latest_sender), ""))}<span class="conv-copy"><span class="conv-top"><span class="conv-title">{esc(conversation['title'])}</span><time class="conv-time">{esc(conversation.get('latest_display', ''))}</time></span><span class="conv-route" title="{esc(raw_participants)}">{esc(participants)}</span><span class="conv-preview">{esc(conversation['latest_body'])}</span><span class="conv-meta"><span>{conversation['message_count']} message{'s' if conversation['message_count'] != 1 else ''}</span>{role_note}</span></span></a>
                <div class="conv-foot">
                  <div class="conv-actions">{actions}</div>
                  <details class="role-editor"><summary>{esc(conversation_role) if conversation_role else "Add role"}</summary>{role_control}</details>
                </div>
              </div>""")
        return f'<div class="conv-list">{"".join(rows)}</div>'

    def render_conversation_detail(
        self,
        project: ProjectSource,
        conversation: dict[str, Any] | None,
        box: str,
        harness_map: dict[str, str] | None = None,
        index: dict[str, dict[str, Any]] | None = None,
    ) -> str:
        harness_map = harness_map or {}
        index = index or {}
        if conversation is None:
            return self.empty_state("No conversation selected", "Choose a conversation from the index to read the full transcript.", cat=True).replace('class="empty-state"', 'class="empty-state detail-empty"', 1)
        transcript = []
        for message in conversation["messages"]:
            recipient = message.get("recipient") or "all"
            sender = clean_text(message.get("sender")) or "unknown"
            kind = clean_text(message.get("priority")).lower()
            badge = f'<span class="msg-type msg-type-{esc(status_class(kind))}">{esc(kind)}</span>' if kind and kind != "normal" else ""
            transcript.append(f"""
              <article class="msg"><div class="msg-head">{avatar_html(self.who(index, sender), harness=harness_map.get(sender, ""))}<div class="msg-who"><strong>{self.who_label(index, sender)}</strong><span>to {self.who_label(index, recipient)}</span>{badge}</div><time class="msg-time">{esc(display_time(message.get('ts')))}</time></div><div class="msg-subject">{esc(message.get('subject') or '(no subject)')}</div><div class="msg-body">{esc(message.get('body') or '')}</div></article>""")
        people = "".join(
            f'<span class="people-chip" title="{esc(participant)}">{avatar_html(self.who(index, participant), size="avatar-s", harness=harness_map.get(participant, ""))}{esc(agent_title(self.who(index, participant)))}</span>'
            for participant in conversation["participants"]
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
            suffix="detail",
            box=box,
        )
        return f"""
          <header class="detail-head"><div><p class="kicker">{esc(conversation.get('thread') or 'Conversation')}</p><h2>{esc(conversation['title'])}</h2><div class="detail-people">{people}<span class="quiet">{conversation['message_count']} message{'s' if conversation['message_count'] != 1 else ''}</span></div></div><div class="detail-actions">{self.conversation_actions(project, conversation['id'], box)}</div></header>
          <div class="detail-role">{role_control}</div>
          <div class="transcript">{''.join(transcript)}</div>
        """

    def conversation_actions(self, project: ProjectSource, conversation_id: str, box: str, compact: bool = False) -> str:
        button_class = "btn btn-quiet btn-small" if compact else "btn btn-small"
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
            forms.append(
                f'<form class="inline-form" method="post" action="/project/{esc(project.key)}/conversations/{action}"{confirm_attr}>'
                f'<input type="hidden" name="csrf" value="{esc(self.csrf_token)}"><input type="hidden" name="conversation_id" value="{esc(conversation_id)}">'
                f'<button class="{button_class}{danger_class}" type="submit" title="{label}">{label}</button></form>'
            )
        return "".join(forms)

    def render_pagination(self, project: ProjectSource, box: str, page: int, page_count: int, search_query: str) -> str:
        if page_count <= 1:
            return ""

        def page_url(number: int) -> str:
            query = urllib.parse.urlencode({"box": box, "page": number, **({"q": search_query} if search_query else {})})
            return f"/project/{esc(project.key)}/messages?{esc(query)}"

        previous = f'<a class="btn btn-small" href="{page_url(page - 1)}">← Previous</a>' if page > 1 else "<span></span>"
        following = f'<a class="btn btn-small" href="{page_url(page + 1)}">Next →</a>' if page < page_count else "<span></span>"
        return f'<nav class="pagination" aria-label="Conversation pages">{previous}<span>Page {page} of {page_count}</span>{following}</nav>'

    def render_compose(self, project: ProjectSource, agents: list[dict[str, Any]]) -> str:
        recipient_options = ['<option value="" selected disabled>Choose a recipient…</option>']
        if agents or project.kind != "workspace":
            recipient_options.append('<option value="all">All project agents</option>')
        recipient_options.extend(
            f'<option value="{esc(agent.get("id"))}">{esc(agent_title(agent))} · {esc(agent_model_line(agent))}</option>' for agent in agents
        )
        can_send = project.kind != "workspace" or bool(agents)
        disabled = "" if can_send else " disabled"
        if project.kind == "workspace":
            note = f"Sends only to agents attached to {project.path_label}." if agents else "No live agents are attached to this folder, so nothing can receive a message yet."
        else:
            note = f"Uses the existing {project.short_name} message command."
        return f"""
          <details class="composer compose"><summary><h2>New message</h2><span class="panel-meta">Compose as operator <span class="chev" aria-hidden="true">›</span></span></summary>
            <form class="compose-form" method="post" action="/project/{esc(project.key)}/messages/send"><input type="hidden" name="csrf" value="{esc(self.csrf_token)}">
              <div class="field"><label for="sender">From</label><input id="sender" name="sender" value="operator" readonly required maxlength="80"></div><div class="field"><label for="recipient">To</label><select id="recipient" name="recipient" required{disabled}>{''.join(recipient_options)}</select></div>
              <div class="field"><label for="subject">Subject</label><input id="subject" name="subject" maxlength="160" placeholder="Optional"{disabled}></div><div class="field"><label for="thread">Thread</label><input id="thread" name="thread" maxlength="120" placeholder="Optional topic"{disabled}></div>
              <div class="field field-wide"><label for="body">Message</label><textarea id="body" name="body" required maxlength="12000" placeholder="Write a message"{disabled}></textarea></div><div class="form-actions"><span class="form-note">{esc(note)}</span><button class="btn btn-primary" type="submit"{disabled}>Send message</button></div>
            </form>
          </details>"""

    def render_conversation_teasers(
        self, project: ProjectSource, conversations: list[dict[str, Any]], index: dict[str, dict[str, Any]] | None = None
    ) -> str:
        index = index or {}
        if not conversations:
            return self.empty_state(
                "No conversations yet",
                "Messages appear when agents are attached to this project’s exact folder. Open Agents to check the roster, or <a href=\"/setup\">check local setup</a>.",
                compact=True,
            )
        rows = []
        for conversation in conversations:
            latest_sender = conversation.get("latest_sender") or "?"
            rows.append(
                f'<a class="teaser" href="/project/{esc(project.key)}/messages?conversation={esc(conversation["id"])}">'
                f'{avatar_html(self.who(index, latest_sender), size="avatar-s")}'
                f'<span class="teaser-copy"><strong>{esc(conversation["title"])}</strong><span title="{esc(", ".join(conversation["participants"]))}">{esc(self.who_names(index, conversation["participants"]))} · {esc(conversation["latest_body"])}</span></span>'
                f'<time>{esc(conversation.get("latest_display", ""))}</time></a>'
            )
        return f'<div class="teaser-list">{"".join(rows)}</div>'

    # ---------- feedback ----------

    @staticmethod
    def flash(query: dict[str, list[str]]) -> str:
        if "error" in query:
            return f'<div class="flash flash-error" role="alert"><div><strong>Action failed</strong>{esc(query["error"][0])}</div></div>'
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
        return f'<div class="flash flash-success" role="status"><div>{messages[action]}</div></div>' if action in messages else ""

    def error_page(self, project: ProjectSource, error: str, active: str = "project") -> str:
        body = (
            f'<header class="page-head"><div><p class="kicker">{esc(project.short_name)}</p><h1>Source unavailable</h1>'
            f'<p class="lede">This project could not be read. No other project data was substituted.</p></div></header>'
            f'<section class="panel"><div class="panel-head"><h2>Check this source</h2>{self.status_pill_named("Unavailable", "failed")}</div>'
            f'<div class="error-copy">{esc(error)}<p><a href="/setup">Open local setup</a> to review the path and connection.</p></div></section>'
        )
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
        if parts[2] == "flags" and parts[3] in {"pin", "unpin", "hide", "unhide"}:
            self.flag_action(project, parts[3])
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

    def flag_action(self, project: ProjectSource, action: str) -> None:
        try:
            if action in {"pin", "unpin"}:
                self.dashboard.state_store.set_pinned(project.key, action == "pin")
            else:
                self.dashboard.state_store.set_hidden(project.key, action == "hide")
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
        body = (
            '<div class="empty-state error-hero"><span class="empty-cat" aria-hidden="true">'
            '<img class="mascot-plain" src="/assets/home-cat.jpg" alt=""><img class="mascot-evil" src="/assets/home-cat-evil.jpg?v=cape" alt=""></span>'
            f'<p class="kicker">Error {int(status)}</p><h1>{esc(message)}</h1>'
            '<p>Return to the projects register and choose an available project.</p>'
            '<div class="empty-actions"><a class="btn btn-primary" href="/">Back to projects</a><a class="btn" href="/setup">Local setup</a></div></div>'
        )
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
        if bind_page_status != 200 or ">3d2f1e91-ead5-46f8-9382-66f2890e7eb5</code>" not in bind_page:
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
        "data-broker-state",
        "data-dock-scrim",
        'class="mascot"',
    ):
        if required not in home:
            failures.append(f"home missing {required!r}")
    if "CloisterBlack" in home:
        failures.append("home still references the retired blackletter font")
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
        if project.kind != "agent-bus" and 'id="tasks"' not in agents_page:
            failures.append(f"{project.key}: agents page missing tasks panel")
        if "data-usage-monitor" not in agents_page and project.kind == "workspace":
            failures.append(f"{project.key}: agents page missing usage monitor")
        overview = dashboard.project_page(project)
        if 'class="stat-row"' not in overview:
            failures.append(f"{project.key}: overview missing summary tiles")
        conversation_page = dashboard.messages_page(project, {})
        for required in ("Conversations", "Inbox", "Archived", "Trash", 'id="conversation-detail"', "details class=\"composer compose\""):
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
        state.set_hidden("demo", True)
        if "demo" not in state.hidden_projects():
            failures.append("hidden project flag did not persist")
        state.set_pinned("demo", True)
        if "demo" in state.hidden_projects() or "demo" not in state.pinned_projects():
            failures.append("pin did not unhide project")
        state.archive_conversations({"demo": ["thread-1"]})
        if state.status("demo", "thread-1") != "archived":
            failures.append("bulk archive did not hide conversation")
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
