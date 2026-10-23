"""
Universal AI Notifier - Python Client (Zero Dependencies)
Works with raw Python, LangChain, CrewAI, AutoGen, or any ML pipeline.
"""

import json
import os
import urllib.request

def notify(
    task: str,
    summary: str,
    workspace: str = "Project",
    user: str = None,
    duration_seconds: int = None,
    url: str = None,
    secret: str = None,
    language: str = "en"
):
    worker_url = url or os.getenv("ANTIGRAVITY_TELEGRAM_URL")
    auth_secret = secret or os.getenv("ANTIGRAVITY_TELEGRAM_SECRET")

    if not worker_url:
        return {"error": "Missing worker URL"}

    payload = {
        "workspace": workspace,
        "prompt": task,
        "summary": summary,
        "user": user or os.getenv("USER") or os.getenv("USERNAME"),
        "durationSeconds": duration_seconds,
        "language": language
    }

    headers = {"Content-Type": "application/json"}
    if auth_secret:
        headers["Authorization"] = f"Bearer {auth_secret}"

    req = urllib.request.Request(
        worker_url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    print("Test run:")
    res = notify(task="Python Pipeline", summary="Data processing completed.")
    print(res)
