#!/usr/bin/env python3
"""
run_req_test.py — fire a variety of LLM calls through the LLMPeek proxy so you
can watch them show up live in the dashboard.

    1. In one terminal:   npm run dev
    2. In another:        python3 run_req_test.py
    3. Watch:             http://127.0.0.1:4319/

No dependencies — pure Python standard library. It points itself at the proxy
and trusts the local LLMPeek CA, so you don't need to export anything first.
"""

import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROXY_PORT = os.environ.get("LLMPEEK_PROXY_PORT", "4318")
COLLECTOR_PORT = os.environ.get("LLMPEEK_PORT", "4319")
PROXY_URL = f"http://127.0.0.1:{PROXY_PORT}"
CA_PATH = os.path.join(BASE_DIR, ".llmpeek", "ca", "ca.pem")
DASHBOARD = f"http://127.0.0.1:{COLLECTOR_PORT}/"

OPENER = None
KEY = None


def load_key():
    key = os.environ.get("PUBLIC_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if key:
        return key
    env_path = os.path.join(BASE_DIR, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() in ("PUBLIC_OPENAI_API_KEY", "OPENAI_API_KEY"):
                    return v.strip().strip('"').strip("'")
    return None


def wait_for_proxy(retries=16):
    for _ in range(retries):
        try:
            with socket.create_connection(("127.0.0.1", int(PROXY_PORT)), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def build_opener():
    # Trust the local LLMPeek CA (the proxy signs per-host leaf certs with it).
    ctx = ssl.create_default_context(cafile=CA_PATH)
    proxy = urllib.request.ProxyHandler({"https": PROXY_URL, "http": PROXY_URL})
    https = urllib.request.HTTPSHandler(context=ctx)
    return urllib.request.build_opener(proxy, https)


def call(path, body, stream=False):
    url = f"https://api.openai.com{path}"
    data = json.dumps(body).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        # mimic the OpenAI Python SDK so the dashboard labels this python/openai
        "x-stainless-lang": "python",
        "User-Agent": "llmpeek-run-req-test/1.0",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    resp = OPENER.open(req, timeout=60)
    if stream:
        pieces = []
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:") :].strip()
            if payload == "[DONE]":
                break
            try:
                delta = json.loads(payload)["choices"][0]["delta"].get("content")
            except Exception:
                delta = None
            if delta:
                pieces.append(delta)
                sys.stdout.write(delta)
                sys.stdout.flush()
        print()
        return "".join(pieces)
    return json.loads(resp.read().decode("utf-8"))


def step(name, fn):
    print(f"● {name}")
    try:
        fn()
    except urllib.error.HTTPError as exc:
        print(f"  (HTTP {exc.code} — captured as an error event in the dashboard)")
    except Exception as exc:  # noqa: BLE001
        print(f"  ! {exc}")
    time.sleep(1.5)  # small gap so you can watch each one land in the dashboard


def non_stream():
    r = call(
        "/v1/chat/completions",
        {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "In one short sentence, what does a proxy server do?"}],
            "max_tokens": 40,
        },
    )
    print("  ", r["choices"][0]["message"]["content"].strip())


def streaming():
    print("  ", end="")
    call(
        "/v1/chat/completions",
        {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Count from 1 to 8, one number per line."}],
            "max_tokens": 60,
            "stream": True,
        },
        stream=True,
    )


def tool_call():
    r = call(
        "/v1/chat/completions",
        {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "What's the weather in Paris? Use the tool."}],
            "max_tokens": 60,
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "Get the current weather for a city",
                        "parameters": {
                            "type": "object",
                            "properties": {"city": {"type": "string"}},
                            "required": ["city"],
                        },
                    },
                }
            ],
        },
    )
    calls = r["choices"][0]["message"].get("tool_calls")
    print("  ", "tool_calls:", json.dumps(calls) if calls else "(model answered directly)")


def embeddings():
    r = call("/v1/embeddings", {"model": "text-embedding-3-small", "input": "LLMPeek makes LLM traffic visible."})
    print(f"   embedded 1 input -> {len(r['data'][0]['embedding'])}-dim vector")


def error_case():
    call(
        "/v1/chat/completions",
        {"model": "gpt-nonexistent-9000", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5},
    )


def main():
    global OPENER, KEY  # noqa: PLW0603
    KEY = load_key()
    if not KEY:
        sys.exit("✗ No API key. Set PUBLIC_OPENAI_API_KEY (or add it to .env next to this script).")

    print(f"→ Waiting for the LLMPeek proxy on {PROXY_URL} ...")
    if not wait_for_proxy():
        sys.exit("✗ Proxy not reachable. Start it first with:  npm run dev")
    if not os.path.exists(CA_PATH):
        sys.exit(f"✗ CA not found at {CA_PATH}\n  Start the proxy in THIS repo first:  npm run dev")

    OPENER = build_opener()
    print(f"→ Connected. Open the dashboard now: {DASHBOARD}\n")

    step("non-streaming chat", non_stream)
    step("streaming chat", streaming)
    step("tool call", tool_call)
    step("embeddings", embeddings)
    step("error (bad model -> error event)", error_case)

    print(f"✓ Done — five requests sent. See them all at {DASHBOARD}")


if __name__ == "__main__":
    main()
