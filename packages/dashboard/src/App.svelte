<script lang="ts">
import type { ContentPart, LLMPeekEvent, NormalizedMessage } from "@llmpeek/schema";
import { type RequestView, applyEvent, emptyView } from "./lib/fold";

const views = $state<Record<string, RequestView>>({});
const order = $state<string[]>([]);
let selectedId = $state<string | null>(null);
let connected = $state(false);

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/stream`);
  ws.onopen = () => {
    connected = true;
  };
  ws.onclose = () => {
    connected = false;
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    let msg: { type: string; event: LLMPeekEvent };
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type !== "event") return;
    const ev = msg.event;
    if (!views[ev.requestId]) {
      views[ev.requestId] = emptyView(ev.requestId);
      order.push(ev.requestId);
      if (!selectedId) selectedId = ev.requestId;
    }
    applyEvent(views[ev.requestId], ev);
  };
}
connect();

const rows = $derived([...order].reverse().map((id) => views[id]));
const selected = $derived(selectedId ? views[selectedId] : undefined);

const tokens = (v: RequestView): string =>
  v.usage ? `${v.usage.promptTokens ?? "?"} / ${v.usage.completionTokens ?? "?"}` : "—";
const ms = (n?: number): string => (n === undefined ? "—" : `${n} ms`);

function partText(p: ContentPart): string {
  if (p.type === "text") return p.text ?? "";
  if (p.type === "tool_use") return `🛠 ${p.name}(${p.argumentsRaw ?? ""})`;
  if (p.type === "tool_result") return `↩ tool_result ${p.toolCallId}`;
  if (p.type === "refusal") return `⛔ ${p.refusal}`;
  if (p.type === "image" || p.type === "audio" || p.type === "file") return `[${p.type}]`;
  return `[${p.type}]`;
}
const msgText = (m: NormalizedMessage): string => (m.content ?? []).map(partText).join("\n");
</script>

<div class="app">
  <header>
    <span class="logo">LLM<b>Peek</b></span>
    <span class="dot" class:on={connected}></span>
    <span class="conn">{connected ? "live" : "reconnecting…"}</span>
    <span class="count">{order.length} request{order.length === 1 ? "" : "s"}</span>
  </header>

  <main>
    <ul class="list">
      {#each rows as r (r.requestId)}
        <li class:selected={r.requestId === selectedId}>
          <button type="button" onclick={() => (selectedId = r.requestId)}>
            <span class="badge {r.status}">{r.status}</span>
            <span class="model">{r.model ?? r.provider ?? "?"}</span>
            <span class="meta">{tokens(r)} · {ms(r.totalMs ?? r.ttftMs)}</span>
          </button>
        </li>
      {/each}
      {#if rows.length === 0}
        <li class="empty">Waiting for LLM calls…</li>
      {/if}
    </ul>

    <section class="detail">
      {#if selected}
        <div class="head">
          <b>{selected.provider}</b> · {selected.model ?? "?"} · {selected.operation ?? "?"}
          <code>{selected.path}</code>
        </div>
        <div class="stats">
          <span class="badge {selected.status}">{selected.status}</span>
          <span>tokens <b>{tokens(selected)}</b></span>
          <span>ttft <b>{ms(selected.ttftMs)}</b></span>
          <span>total <b>{ms(selected.totalMs)}</b></span>
          {#if selected.finishReason}<span>finish <b>{selected.finishReason}</b></span>{/if}
          {#if selected.cost?.totalCost != null}<span>cost <b>${selected.cost.totalCost.toFixed(5)}</b></span>{/if}
        </div>
        {#if selected.errorMessage}<pre class="error">{selected.errorMessage}</pre>{/if}

        <h3>Prompt</h3>
        {#each selected.promptMessages as m}
          <div class="msg"><span class="role">{m.role}</span><pre>{msgText(m)}</pre></div>
        {/each}

        <h3>Response</h3>
        {#if selected.status === "streaming"}
          <pre class="stream">{selected.streamingText}<span class="caret">▍</span></pre>
        {:else if selected.responseMessages.length}
          {#each selected.responseMessages as m}
            <div class="msg"><span class="role">{m.role}</span><pre>{msgText(m)}</pre></div>
          {/each}
        {:else}
          <div class="muted">—</div>
        {/if}
      {:else}
        <div class="placeholder">Select a request to inspect its prompt, streaming, and tokens.</div>
      {/if}
    </section>
  </main>
</div>

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; border-bottom: 1px solid var(--line);
  }
  .logo { font-weight: 500; letter-spacing: 0.5px; }
  .logo b { color: var(--accent); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: #35c759; }
  .conn { color: var(--muted); font-size: 13px; }
  .count { margin-left: auto; color: var(--muted); font-size: 13px; }

  main { flex: 1; display: grid; grid-template-columns: 300px 1fr; min-height: 0; }
  .list { overflow-y: auto; border-right: 1px solid var(--line); }
  .list li.selected button { background: var(--sel); }
  .list button {
    width: 100%; text-align: left; background: none; border: none; color: inherit;
    padding: 9px 14px; cursor: pointer; border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 8px; font: inherit;
  }
  .list button:hover { background: var(--hover); }
  .model { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .empty, .placeholder, .muted { color: var(--muted); padding: 16px; }

  .detail { overflow-y: auto; padding: 16px 20px; }
  .head { margin-bottom: 8px; }
  .head code { color: var(--muted); }
  .stats { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-bottom: 14px; color: var(--muted); font-size: 13px; }
  .stats b { color: var(--fg); }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); margin: 16px 0 6px; }
  .msg { margin-bottom: 8px; }
  .role { display: inline-block; font-size: 11px; text-transform: uppercase; color: var(--accent); margin-bottom: 2px; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: var(--mono); font-size: 13px; line-height: 1.5; }
  .stream { color: var(--fg); }
  .caret { animation: blink 1s steps(2) infinite; color: var(--accent); }
  .error { color: #ff6b6b; }

  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.4px; }
  .badge.pending { background: #3a3a1a; color: #d8d85a; }
  .badge.streaming { background: #1a2f3a; color: #5ac8fa; }
  .badge.completed { background: #16351f; color: #35c759; }
  .badge.error { background: #3a1a1a; color: #ff6b6b; }

  @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0; } }
</style>
