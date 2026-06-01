#!/usr/bin/env python3
"""
E2E test: Verify custom workspace directory is correctly bind-mounted.

1. Create session, set workspace BEFORE sandbox creation
2. Trigger sandbox via WebSocket
3. Verify Docker container has correct bind mount
4. Write test file via docker exec → verify appears in workspace dir
"""
import json, os, sys, time, urllib.request, ssl, subprocess

BASE = "http://localhost:3000"
WS = "ws://localhost:3000/ws"
SANDBOX_ROOT = os.path.join(os.path.dirname(__file__), "..", ".sandboxes")

# Use testAgent/ as the custom workspace
WORKSPACE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "testAgent"))
os.makedirs(WORKSPACE_DIR, exist_ok=True)

def get_token():
    return json.loads(urllib.request.urlopen(
        urllib.request.Request(f"{BASE}/api/auth/dev-token")
    ).read())["token"]

def api(method, path, body=None):
    token = get_token()
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, context=ssl._create_unverified_context()) as r:
            return r.status, json.loads(r.read()) if r.status != 204 else None
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return e.code, body

def main():
    print("=" * 60)
    print("E2E Test: Custom Workspace Docker Bind Mount")
    print("=" * 60)
    token = get_token()

    # 1. Create session
    print("\n--- 1. Create Session ---")
    status, data = api("POST", "/api/sessions", {"title": "Workspace Bind Test", "type": "group"})
    assert status == 201, f"Create session failed: {status} {data}"
    session_id = data["id"]
    sandbox_dir = os.path.join(SANDBOX_ROOT, session_id)
    print(f"  ✅ Created: {session_id}")

    # 2. Add Planner agent (needed for chat message to work)
    print("\n--- 2. Add Agents ---")
    # Get available agents
    _, agents = api("GET", "/api/agents")
    planner = next((a for a in agents if a["name"].startswith("planner")), agents[0])
    code_agent = next((a for a in agents if a["name"].startswith("code-agent")), agents[0])
    status, _ = api("POST", f"/api/sessions/{session_id}/agents", {
        "agentIds": [planner["id"], code_agent["id"]]
    })
    print(f"  ✅ Added: {planner['name']}, {code_agent['name']}")

    # 3. Set workspace BEFORE sandbox creation
    print(f"\n--- 3. Set Workspace to {WORKSPACE_DIR} ---")
    status, data = api("POST", f"/api/sessions/{session_id}/workspace", {
        "path": WORKSPACE_DIR,
        "mode": "custom",
        "writePermission": "auto",
    })
    assert status == 200, f"Set workspace failed: {status} {data}"
    print(f"  ✅ Workspace set: {data}")
    assert data["path"] == WORKSPACE_DIR, f"Path mismatch: {data['path']} != {WORKSPACE_DIR}"

    # 4. Trigger sandbox creation via WebSocket connection
    # Sandbox is created on WS connect (getOrCreateSandbox called at handler.ts:147)
    print("\n--- 4. Trigger Sandbox via WebSocket ---")
    import websocket
    ws = websocket.create_connection(f"{WS}?token={token}&sessionId={session_id}")
    print(f"  ✅ WebSocket connected (sandbox should be created)")

    # Wait for sandbox/Docker container to be created
    time.sleep(3)

    # 5. Verify Docker container bind mount
    print("\n--- 5. Verify Docker Bind Mount ---")
    container_name = f"agenthub-sandbox-{session_id}"
    result = subprocess.run(
        ["docker", "inspect", container_name, "--format", "{{range .Mounts}}{{if eq .Destination \"/workspace\"}}{{.Source}}{{end}}{{end}}"],
        capture_output=True, text=True
    )
    actual_bind = ""
    if result.returncode == 0:
        actual_bind = result.stdout.strip()
        print(f"  Container bind mount source: {actual_bind}")
        if actual_bind == WORKSPACE_DIR:
            print(f"  ✅ Bind mount matches workspace directory")
        else:
            print(f"  ❌ Bind mount MISMATCH!")
            print(f"     Expected: {WORKSPACE_DIR}")
            print(f"     Actual:   {actual_bind}")
    else:
        print(f"  ⚠️  Container inspect failed: {result.stderr}")

    # 6. Test bind mount by writing via docker exec
    print("\n--- 6. Test File Write via docker exec ---")
    test_content = "e2e_bind_test_success"
    test_file_rel = "e2e_test_workspace.txt"

    if result.returncode == 0:
        exec_result = subprocess.run(
            ["docker", "exec", container_name, "sh", "-c", f"echo '{test_content}' > /workspace/{test_file_rel}"],
            capture_output=True, text=True
        )
        if exec_result.returncode == 0:
            print(f"  ✅ Wrote test file via docker exec")
        else:
            print(f"  ❌ docker exec failed: {exec_result.stderr}")
    else:
        print(f"  ⏭️  Skipping — container not found")

    # 7. Verify file appears in workspace directory, NOT in sandbox
    print("\n--- 7. Verify File Location ---")
    test_file = os.path.join(WORKSPACE_DIR, test_file_rel)
    sandbox_test_file = os.path.join(sandbox_dir, test_file_rel) if os.path.isdir(sandbox_dir) else None

    workspace_has_file = os.path.isfile(test_file)
    sandbox_has_file = sandbox_test_file and os.path.isfile(sandbox_test_file)

    print(f"  Workspace file ({test_file}): {'✅ EXISTS' if workspace_has_file else '❌ MISSING'}")
    if sandbox_test_file:
        print(f"  Sandbox file ({sandbox_test_file}): {'⚠️ EXISTS (wrong!)' if sandbox_has_file else '✅ ABSENT (correct)'}")

    if workspace_has_file:
        with open(test_file) as f:
            content = f.read().strip()
            print(f"  Content: {content}")
            assert content == test_content, f"Content mismatch: {content} != {test_content}"
        os.remove(test_file)  # Cleanup
        print(f"  🧹 Cleaned up test file")

    ws.close()

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    results = [
        ("Session created", True),
        ("Workspace set", True),
        ("Sandbox triggered", True),
        ("Bind mount correct", actual_bind == WORKSPACE_DIR if result.returncode == 0 else None),
        ("File in workspace dir", workspace_has_file),
        ("File NOT in sandbox dir", not sandbox_has_file if sandbox_test_file else True),
    ]
    all_pass = True
    for name, ok in results:
        icon = "✅" if ok else ("⚠️" if ok is None else "❌")
        if not ok: all_pass = False
        print(f"  {icon} {name}")

    print(f"\n  Overall: {'✅ ALL PASS' if all_pass else '❌ SOME FAILED'}")
    return 0 if all_pass else 1

if __name__ == "__main__":
    sys.exit(main())
