#!/usr/bin/env python3
"""Brings Chomp's answers into the Claude Code session that asked, even when it did not wait for them.

message_chat and start_chat return a reply ticket. This hook keeps the tickets a session got (PostToolUse on
those tools), and hands the session each answer once its Chomp chat has finished, as context on the next tool
call or prompt, or by holding the session open when it would otherwise stop (Stop). Tickets live in Chomp's
database, so a Chomp restart in the middle of an answer loses nothing.

Install: copy to ~/.claude/hooks/ and register it for PostToolUse (matcher "*"), UserPromptSubmit and Stop
with `python3 ~/.claude/hooks/chomp-replies.py`. Address and token come from CHOMP_MCP_URL and
CHOMP_MCP_TOKEN, or else from the "chomp" MCP server in ~/.claude.json. It never fails the session: on any
error it exits quietly and tries again next time.
"""
import json
import os
import re
import sys
import time
import urllib.request

STATE_DIR = os.path.expanduser("~/.claude/chomp-replies")
TICKET = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@\d{4}-\d\d-\d\dT[\d:.]+Z")
SEND_TOOL = re.compile(r"^mcp__.*chomp.*__(message_chat|start_chat)$")
MAX_AGE_S = 24 * 3600
CHECK_EVERY_S = 15  # between checks on ordinary tool calls, so a busy session does not hammer Chomp
TIMEOUT_S = 8


def chomp():
    url, token = os.environ.get("CHOMP_MCP_URL"), os.environ.get("CHOMP_MCP_TOKEN")
    if url and token:
        return url, "Bearer " + token
    with open(os.path.expanduser("~/.claude.json")) as f:
        server = json.load(f).get("mcpServers", {}).get("chomp", {})
    return server["url"], server["headers"]["Authorization"]


def get_reply(ticket):
    url, auth = chomp()
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": "get_reply", "arguments": {"ticket": ticket}}}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "Authorization": auth})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        result = json.load(res).get("result", {})
    if result.get("isError"):
        return {"status": "gone", "text": ""}  # a ticket Chomp cannot read never will be
    state = result.get("structuredContent") or {}
    return {"status": state.get("status", "working"), "text": (result.get("content") or [{}])[0].get("text", "")}


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"tickets": {}, "checked": 0}


def save(path, state):
    if not state["tickets"]:
        if os.path.exists(path):
            os.remove(path)
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def collect(state):
    """Answers that are in, oldest first. Drops them, and tickets past their age, from the state."""
    answers = []
    now = time.time()
    for ticket, added in sorted(state["tickets"].items(), key=lambda item: item[1]):
        if now - added > MAX_AGE_S:
            del state["tickets"][ticket]
            continue
        reply = get_reply(ticket)
        if reply["status"] == "working":
            continue
        del state["tickets"][ticket]
        if reply["status"] == "answered":
            answers.append(reply["text"])
    state["checked"] = now
    return answers


def main():
    event = json.load(sys.stdin)
    name = event.get("hook_event_name", "")
    session = re.sub(r"[^A-Za-z0-9_-]", "", event.get("session_id", "")) or "default"
    path = os.path.join(STATE_DIR, session + ".json")
    state = load(path)

    if name == "PostToolUse" and SEND_TOOL.match(event.get("tool_name", "")):
        response = json.dumps(event.get("tool_response", ""))
        # Only a call that came back without its answer leaves anything to fetch.
        if "Reply ticket:" in response or "still working" in response:
            for ticket in TICKET.findall(response):
                state["tickets"].setdefault(ticket, time.time())
        save(path, state)
        return

    if not state["tickets"]:
        return
    if name == "PostToolUse" and time.time() - state.get("checked", 0) < CHECK_EVERY_S:
        return
    answers = collect(state)
    save(path, state)
    if not answers:
        return

    message = "Chomp answered a message you sent it earlier:\n\n" + "\n\n---\n\n".join(answers)
    if name == "Stop":
        print(json.dumps({"decision": "block", "reason": message}))
    else:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": name, "additionalContext": message}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # never break the session over a missed reply; it is fetched next time
        pass
