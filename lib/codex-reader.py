"""Read-only adapter for installed Codex history. No resume, input or migrations."""
import json
import os
import re
import sqlite3
import sys
import stat
from datetime import datetime
from pathlib import Path

UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
ACTION_TYPES = {
    "commandExecution": "执行命令", "fileChange": "修改文件", "webSearch": "网页搜索",
    "mcpToolCall": "调用工具", "dynamicToolCall": "调用工具", "functionCallOutput": "工具结果",
    "plan": "任务计划", "collabAgentToolCall": "协作任务", "subAgentActivity": "子任务动态",
    "imageView": "查看图片", "imageGeneration": "生成图片", "sleep": "等待",
    "contextCompaction": "整理上下文", "enteredReviewMode": "开始评审", "exitedReviewMode": "结束评审",
}
VISIBLE_TYPES = ["userMessage", "agentMessage", *ACTION_TYPES]


def redact(text):
    """Best-effort credential scrubbing, not a license to publish private logs."""
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----", "[私钥已隐藏]", text)
    text = re.sub(r"\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})", "[凭据已隐藏]", text)
    text = re.sub(r"(?i)(bearer\s+)[\w.\-+/=]+", r"\1[已隐藏]", text)
    text = re.sub(r'''(?im)(\b["']?(?:[\w-]{0,64}(?:password|passwd|secret|token|api[_-]?key)|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n}]+)''', r"\1[已隐藏]", text)
    return text


def safe_value(value, depth=0):
    if depth > 5:
        return "…"
    if isinstance(value, str):
        return redact(value)[:12000]
    if isinstance(value, dict):
        return {str(k): ("[已隐藏]" if re.search(r"(?i)secret|password|token|authorization|cookie|api.?key", str(k)) else safe_value(v, depth+1))
                for k, v in list(value.items())[:40] if str(k) not in ("reasoning", "system", "developer", "encrypted_content")}
    if isinstance(value, list):
        return [safe_value(v, depth+1) for v in value[:30]]
    return value


def activity(item, row):
    kind = item["type"]
    if kind not in ACTION_TYPES:
        return None
    # A malformed/hidden record must not become an empty successful command.
    if kind == "commandExecution" and not isinstance(item.get("command"), str):
        return None
    details, truncated = [], False

    def add(label, value):
        nonlocal truncated
        if value is None or value == "" or value == []:
            return
        clean = safe_value(value)
        text = clean if isinstance(clean, str) else json.dumps(clean, ensure_ascii=False, indent=2)
        remaining = max(0, 20000 - sum(len(d["text"]) for d in details))
        cap = min(10000, remaining)
        # Signal all clipping, including the bounded structured projection.
        truncated |= len(str(value)) > len(str(clean)) or len(text) > cap
        if cap:
            details.append({"label": label, "text": text[:cap]})

    title = ACTION_TYPES[kind]
    status = item.get("status") or "recorded"
    if kind == "commandExecution":
        add("命令", item.get("command")); add("工作目录", item.get("cwd"))
        add("输出", item.get("aggregatedOutput")); add("退出码", item.get("exitCode"))
    elif kind == "fileChange":
        for change in item.get("changes", [])[:20]:
            add("文件", change.get("path")); add("变更", {"kind": change.get("kind"), "diff": change.get("diff")})
        truncated |= len(item.get("changes", [])) > 20
    elif kind == "webSearch":
        add("检索", item.get("query")); add("操作", item.get("action"))
        # Results may contain huge snapshots; expose source titles/URLs only.
        results = item.get("results")
        if isinstance(results, list):
            add("来源", [{k: r[k] for k in ("title", "url") if k in r} for r in results[:20] if isinstance(r, dict)])
    elif kind in ("mcpToolCall", "dynamicToolCall"):
        title = "调用 " + str(item.get("tool") or "工具")[:100]
        add("工具", {k: item[k] for k in ("server", "namespace", "tool") if k in item})
        add("参数", item.get("arguments")); add("结果", item.get("result", item.get("contentItems")))
        add("错误", item.get("error"))
    elif kind == "functionCallOutput":
        add("工具", item.get("name")); add("结果", item.get("output"))
    elif kind == "plan":
        add("计划", item.get("text"))
    elif kind in ("collabAgentToolCall", "subAgentActivity"):
        # No delegated prompt or private agent-state dump.
        add("动作", item.get("tool", item.get("kind")))
        add("子任务", item.get("agentPath")); add("模型", item.get("model"))
    elif kind in ("imageView", "imageGeneration"):
        add("文件", item.get("path", item.get("savedPath")))
        add("生成提示词", item.get("revisedPrompt")); add("错误", item.get("failure"))
        add("说明", "图片内容请在原终端或本会话的网页预览中查看。")
    elif kind == "sleep":
        add("等待", {k: item[k] for k in ("durationMs", "duration_ms", "wakeReason") if k in item})
    elif kind in ("enteredReviewMode", "exitedReviewMode"):
        add("评审", item.get("review"))
    duration = item.get("durationMs")
    if isinstance(duration, (int, float)):
        add("耗时", f"{duration / 1000:.1f} 秒")
    return {"id": str(row["rollout_ordinal"]), "role": "activity", "type": kind,
            "title": redact(title), "status": status, "details": details,
            "text": redact(title), "truncated": truncated, "time": row["created_at_ms"]}


def process(pid):
    text = Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rfind(")") + 2:].split()
    return text[text.find("(") + 1:text.rfind(")")], fields[19]


def locate(pane_pid, home):
    queue, seen, candidates = [pane_pid], set(), []
    while queue and len(seen) < 256:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        try:
            name, started = process(pid)
            if name == "codex":
                locks = set()
                for fd in Path(f"/proc/{pid}/fd").iterdir():
                    try:
                        target = Path(os.readlink(fd))
                        if target.parent == home / "thread-writer-locks" and target.suffix == ".lock" and UUID.fullmatch(target.stem):
                            locks.add(target.stem)
                    except FileNotFoundError:
                        pass
                candidates.append((pid, started, locks))
                # Nested tools/agents are not the pane's interactive CLI.
                continue
            queue.extend(int(p) for p in Path(f"/proc/{pid}/task/{pid}/children").read_text().split())
        except (FileNotFoundError, ProcessLookupError):
            continue
    if len(candidates) != 1:
        raise ValueError("mapping")
    return candidates[0]


def database(home, name):
    connection = sqlite3.connect((home / name).as_uri() + "?mode=ro", uri=True, timeout=1)
    connection.execute("PRAGMA query_only=ON")
    connection.row_factory = sqlite3.Row
    return connection


def visible(row):
    if row["item_json"] is None:
        kind = row["item_type"]
        # Never return binary image results or megabyte-sized tool payloads.
        # Retain the position, but do not invent completion or lost content.
        if kind not in ACTION_TYPES:
            return None
        return {"id": str(row["rollout_ordinal"]), "role": "activity", "type": kind,
                "title": ACTION_TYPES[kind], "status": "recorded", "details": [],
                "text": ACTION_TYPES[kind], "truncated": True, "time": row["created_at_ms"]}
    item = json.loads(row["item_json"])
    if item.get("type") == "agentMessage" and item.get("phase") in (None, "final_answer", "final", "commentary"):
        role, text = "assistant", item.get("text", "")
    elif item.get("type") == "userMessage":
        role, parts = "user", []
        for part in item.get("content", []):
            if part.get("type") == "text":
                parts.append(part.get("text", ""))
            elif part.get("type") in ("image", "localImage"):
                parts.append("〔图片附件 · 请在原终端查看〕")
        text = "\n".join(parts)
    else:
        return activity(item, row)
    if not isinstance(text, str) or not text.strip():
        return None
    return {"id": str(row["rollout_ordinal"]), "role": role,
            "phase": item.get("phase"), "text": text[:32000],
            "truncated": len(text) > 32000, "time": row["created_at_ms"]}


def read_history(home, thread, before=None, revision=None, lookup=None):
    with database(home, "thread_history_1.sqlite") as db:
        db.execute("BEGIN")
        if lookup:
            rows = db.execute("SELECT rollout_ordinal,created_at_ms,item_type,CASE WHEN length(item_json)<=100000 THEN item_json ELSE NULL END AS item_json FROM thread_items WHERE thread_id=? AND item_type='userMessage' AND created_at_ms>=? ORDER BY rollout_ordinal DESC LIMIT 200", (thread, lookup["since"])).fetchall()
            matches = [m for row in rows if (m := visible(row)) and m["role"] == "user" and m["text"] == lookup["text"] and not m.get("truncated")]
            return {"matches": matches[:20]}
        last = db.execute("SELECT updated_at_ordinal FROM thread_items WHERE thread_id=? ORDER BY updated_at_ordinal DESC LIMIT 1", (thread,)).fetchone()
        stamp = str(last[0]) if last else "0"
        if before is None and revision == stamp:
            return {"unchanged": True, "revision": stamp}
        limit = before if before is not None else 9223372036854775807
        marks = ','.join('?' for _ in VISIBLE_TYPES)
        rows = db.execute(f"SELECT rollout_ordinal,created_at_ms,item_type,CASE WHEN length(item_json)<=524288 THEN item_json ELSE NULL END AS item_json FROM thread_items WHERE thread_id=? AND rollout_ordinal<? AND item_type IN ({marks}) ORDER BY rollout_ordinal DESC LIMIT 81", (thread, limit, *VISIBLE_TYPES)).fetchall()
        messages, budget, consumed, public_count = [], 0, [], 0
        for row in rows[:80]:
            message = visible(row)
            size = len(json.dumps(message, ensure_ascii=False).encode()) if message else 0
            if budget + size > 256000 and consumed:
                break
            consumed.append(row["rollout_ordinal"])
            if message:
                messages.append(message)
                budget += size
                public_count += message["role"] != "activity"
            # Keep enough surrounding conversation when a turn contains many
            # tools, while bounding every page regardless of a giant turn.
            if len(messages) >= 20 and public_count >= 6:
                break
        older = min(consumed) if consumed and len(rows) > len(consumed) else None
        return {"messages": list(reversed(messages)), "before": older, "revision": stamp}


def legacy_item(record):
    """Project public legacy events to the same allowlisted UI items.

    Public messages come from event_msg only: response_item user messages may
    contain injected workspace instructions, and assistant messages are duplicates.
    Never expose world_state, turn_context, reasoning or session metadata.
    """
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    kind, envelope = payload.get("type"), record.get("type")
    if envelope == "event_msg":
        if kind == "user_message" and isinstance(payload.get("message"), str):
            content = [{"type": "text", "text": payload["message"]}]
            if payload.get("images") or payload.get("local_images"):
                content.append({"type": "image"})
            if payload.get("audio") or payload.get("local_audio"):
                content.append({"type": "text", "text": "〔语音附件 · 请在原终端查看〕"})
            return {"type": "userMessage", "content": content}
        if kind == "agent_message" and isinstance(payload.get("message"), str):
            return {"type": "agentMessage", "text": payload["message"], "phase": payload.get("phase")}
        if kind == "context_compacted":
            return {"type": "contextCompaction", "status": "completed"}
        return None
    if envelope != "response_item":
        return None
    if kind in ("function_call", "custom_tool_call"):
        name = payload.get("name")
        if not isinstance(name, str):
            return None
        # Delegated prompts/private agent states aren't conversation history.
        if name.rsplit(".", 1)[-1] in ("spawn_agent", "send_message", "followup_task", "wait_agent"):
            return {"type": "collabAgentToolCall", "tool": name, "status": "recorded"}
        arguments = payload.get("arguments", payload.get("input"))
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except ValueError:
                pass
        return {"type": "dynamicToolCall", "tool": name, "arguments": arguments, "status": "recorded"}
    if kind in ("function_call_output", "custom_tool_call_output"):
        return {"type": "functionCallOutput", "output": payload.get("output"), "status": "recorded"}
    if kind == "web_search_call":
        return {"type": "webSearch", "action": payload.get("action"), "status": "recorded"}
    return None


def read_legacy(home, thread, rollout, before=None, revision=None, window_bytes=8*1024*1024, lookup=None):
    """Bounded reverse JSONL pagination. Cursors/IDs are stable byte offsets.

    No migration, index or copy of the original file. Each request reads at most
    one bounded window plus the identity header. An oversized/partial record is
    never parsed, and an older cursor still advances through empty windows.
    """
    path = Path(rollout).resolve(strict=True)
    if not any(path.is_relative_to(home / name) for name in ("sessions", "archived_sessions")) or path.suffix != ".jsonl":
        raise ValueError("rollout path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        snapshot = os.fstat(source.fileno())
        if not stat.S_ISREG(snapshot.st_mode):
            raise ValueError("rollout file")
        header = source.readline(2*1024*1024)
        if not header.endswith(b"\n"):
            raise ValueError("rollout header")
        meta = json.loads(header)
        if meta.get("type") != "session_meta" or meta.get("payload", {}).get("id") != thread:
            raise ValueError("rollout identity")
        stamp = str(snapshot.st_mtime_ns // 1000)
        if before is not None and (not isinstance(before, int) or not 0 <= before <= snapshot.st_size):
            return {"available": False, "reason": "changed"}
        if not lookup and before is None and revision == stamp:
            return {"unchanged": True, "revision": stamp}
        end = snapshot.st_size if before is None else before
        start = max(0, end-window_bytes)
        source.seek(start)
        data = source.read(end-start)
        # A trailing partial append isn't a record. Never render incomplete JSON.
        cursor = data.rfind(b"\n") + 1
        floor = data.find(b"\n") + 1 if start else 0
        messages, budget, public_count = [], 0, 0
        skipped = bool(start and (floor > 524288 or cursor == 0))
        while cursor > floor:
            previous = data.rfind(b"\n", 0, cursor-1) + 1
            if previous < floor:
                break
            line = data[previous:cursor-1]
            message = None
            if len(line) > 524288:
                skipped = True
            else:
                try:
                    record = json.loads(line)
                    item = legacy_item(record) if not lookup or (record.get("type") == "event_msg" and record.get("payload", {}).get("type") == "user_message") else None
                    if item:
                        timestamp = record.get("timestamp")
                        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                        message = visible({"rollout_ordinal": start+previous,
                                           "created_at_ms": int(moment.timestamp()*1000),
                                           "item_json": json.dumps(item, ensure_ascii=False)})
                except (ValueError, TypeError, KeyError, AttributeError):
                    skipped = True
            if lookup and message and (message["role"] != "user" or message["text"] != lookup["text"] or message["time"] < lookup["since"] or message.get("truncated")):
                message = None
            size = len(json.dumps(message, ensure_ascii=False).encode()) if message else 0
            if budget+size > 256000 and messages:
                break
            cursor = previous
            if message:
                messages.append(message)
                budget += size
                public_count += message["role"] != "activity"
            if len(messages) >= 80 or (len(messages) >= 20 and public_count >= 6):
                break
        # When a whole window is inside one enormous record, move backwards;
        # no unbounded scan just to discover its beginning.
        if cursor <= floor:
            cursor = floor if floor < len(data) else 0
        older = start+cursor if start+cursor > len(header) else None
        if older is not None and older >= end:
            older = start or None
        current = path.stat()
        if (current.st_dev, current.st_ino) != (snapshot.st_dev, snapshot.st_ino) or current.st_size < snapshot.st_size:
            return {"available": False, "reason": "changed"}
        if lookup:
            return {"matches": messages}
        result = {"messages": list(reversed(messages)), "before": older, "revision": stamp}
        if skipped or (not messages and older is not None):
            result["notice"] = "本页已略过超大或无法显示的记录，可继续查看更早消息；原记录未改动。"
        return result


def main(request):
    home = Path(request["home"]).resolve(strict=True)
    pid, started, locks = locate(int(request["pid"]), home)
    with database(home, "state_5.sqlite") as state:
        threads = []
        for thread in locks:
            row = state.execute("SELECT id,source,history_mode,model,reasoning_effort,rollout_path FROM threads WHERE id=?", (thread,)).fetchone()
            if row and row["source"] in ("cli", "vscode"):
                threads.append(dict(row))
    if len(threads) != 1:
        raise ValueError("mapping")
    thread = threads[0]
    if thread["history_mode"] not in ("paginated", "legacy"):
        return {"available": False, "reason": "format"}
    binding = f"{pid}:{started}:{thread['id']}"
    if request.get("binding") and request["binding"] != binding:
        return {"available": False, "reason": "changed"}
    before = request.get("before")
    if before is not None and (not request.get("binding") or not isinstance(before, int) or before < 0):
        raise ValueError("cursor")
    revision = request.get("revision") if request.get("binding") else None
    lookup = request.get("lookup")
    if lookup is not None and (not request.get("binding") or not isinstance(lookup, dict) or not isinstance(lookup.get("text"), str) or not 0 < len(lookup["text"].encode()) <= 12000 or not isinstance(lookup.get("since"), int) or lookup["since"] < 0):
        raise ValueError("receipt lookup")
    if thread["history_mode"] == "legacy":
        result = read_legacy(home, thread["id"], thread["rollout_path"], before, revision, lookup=lookup)
    else:
        result = read_history(home, thread["id"], before, revision, lookup=lookup)
    if result.get("available") is False:
        return result
    if locate(int(request["pid"]), home) != (pid, started, locks):
        return {"available": False, "reason": "changed"}
    return {"available": True, "binding": binding, "model": thread["model"],
            "effort": thread["reasoning_effort"], **result}


if __name__ == "__main__":
    try:
        answer = main(json.load(sys.stdin))
    except (ValueError, KeyError, OSError, sqlite3.Error, json.JSONDecodeError):
        # Never print paths, db contents, prompts or credentials on errors.
        answer = {"available": False, "reason": "unavailable"}
    print(json.dumps(answer, ensure_ascii=False))
