"""Self-check for chomp-replies.py against a fake Chomp: python3 plugins/chomp/hooks/test_chomp_replies.py"""
import json, os, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chomp-replies.py")
TICKET = "0a0a0a0a-4444-4444-8444-444444444444@2026-11-08T00:57:02.123Z"
status = {"value": "working"}

class Fake(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert self.headers["Authorization"] == "Bearer secret-token"
        assert body["params"] == {"name": "get_reply", "arguments": {"ticket": TICKET}}
        text = "chat answered:\n\nThe 780M draws it." if status["value"] == "answered" else "still working"
        out = {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": text}], "isError": False,
               "structuredContent": {"status": status["value"], "ticket": TICKET}}}
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *args): pass

server = HTTPServer(("127.0.0.1", 0), Fake)
threading.Thread(target=server.serve_forever, daemon=True).start()
home = tempfile.mkdtemp()
env = {**os.environ, "HOME": home, "CHOMP_MCP_URL": f"http://127.0.0.1:{server.server_port}/", "CHOMP_MCP_TOKEN": "secret-token"}

def run(event):
    out = subprocess.run([sys.executable, HOOK], input=json.dumps({"session_id": "s1", **event}), capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()

sent = {"hook_event_name": "PostToolUse", "tool_name": "mcp__chomp__message_chat",
        "tool_response": [{"type": "text", "text": f"Sent to chat. Reply ticket: {TICKET} (get the answer with get_reply)"}]}
assert run(sent) == ""
assert run({"hook_event_name": "Stop"}) == "", "nothing while Chomp is still working"
status["value"] = "answered"
stop = json.loads(run({"hook_event_name": "Stop"}))
assert stop["decision"] == "block" and "The 780M draws it." in stop["reason"]
assert run({"hook_event_name": "Stop"}) == "", "each answer is handed over once"

run(sent)  # a waited call that already answered keeps nothing
run({"hook_event_name": "PostToolUse", "tool_name": "mcp__chomp__message_chat", "tool_response": [{"type": "text", "text": f"chat answered:\n\n{TICKET} ok"}]})
prompt = json.loads(run({"hook_event_name": "UserPromptSubmit"}))
assert "The 780M draws it." in prompt["hookSpecificOutput"]["additionalContext"]
assert run({"hook_event_name": "UserPromptSubmit"}) == ""

env["CHOMP_MCP_URL"] = "http://127.0.0.1:1/"  # Chomp down: the hook stays quiet and keeps the ticket
run(sent)
assert run({"hook_event_name": "Stop"}) == ""
assert os.path.exists(os.path.join(home, ".claude/chomp-replies/s1.json"))
print("chomp-replies hook: all checks passed")
