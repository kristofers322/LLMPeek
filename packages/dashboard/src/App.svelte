<script lang="ts">
import type { ContentPart, LLMPeekEvent, NormalizedMessage } from "@llmpeek/schema";
import { tick } from "svelte";
import { type RequestView, applyEvent, emptyView } from "./lib/fold";

const views = $state<Record<string, RequestView>>({});
const order = $state<string[]>([]);
let selectedId = $state<string | null>(null);
let connected = $state(false);
// biome-ignore lint/style/useConst: reassigned from Svelte event handlers in markup.
let activeTab = $state<"overview" | "logs" | "connect">("overview");
let requestLog = $state<HTMLUListElement>();
let copied = $state<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function focusNewestLogRequest(requestId: string): Promise<void> {
  await tick();
  if (activeTab !== "logs" || order.at(-1) !== requestId) return;
  requestLog?.querySelector<HTMLButtonElement>("button")?.focus();
}

function copy(text: string, id: string): void {
  navigator.clipboard
    ?.writeText(text)
    .then(() => {
      copied = id;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = null;
      }, 1200);
    })
    .catch(() => {});
}

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
      selectedId = ev.requestId;
      void focusNewestLogRequest(ev.requestId);
    }
    applyEvent(views[ev.requestId], ev);
  };
}
connect();

const rows = $derived([...order].reverse().map((id) => views[id]));
const selected = $derived(selectedId ? views[selectedId] : undefined);
// With no captured requests yet, show the Connect onboarding regardless of tab;
// the first event flips the user straight to their chosen live view.
const view = $derived(order.length === 0 ? "connect" : activeTab);
const completedRows = $derived(rows.filter((r) => r.status === "completed"));
const activeRows = $derived(rows.filter((r) => r.status === "pending" || r.status === "streaming"));
const errorRows = $derived(rows.filter((r) => r.status === "error"));
const averageLatency = $derived.by(() => {
  const values = rows.map((r) => r.totalMs).filter((n): n is number => n !== undefined);
  if (!values.length) return undefined;
  return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
});
const totalCost = $derived(rows.reduce((sum, r) => sum + (r.cost?.totalCost ?? 0), 0));
const latestRows = $derived(rows.slice(0, 6));

const tokens = (v: RequestView): string =>
  v.usage ? `${v.usage.promptTokens ?? "?"} / ${v.usage.completionTokens ?? "?"}` : "-";
const ms = (n?: number): string => (n === undefined ? "-" : `${n} ms`);
const money = (n: number): string => (n > 0 ? `$${n.toFixed(5)}` : "-");

function partText(p: ContentPart): string {
  if (p.type === "text") return p.text ?? "";
  if (p.type === "tool_use") return `tool ${p.name}(${p.argumentsRaw ?? ""})`;
  if (p.type === "tool_result") return `tool_result ${p.toolCallId}`;
  if (p.type === "refusal") return `refusal ${p.refusal}`;
  if (p.type === "image" || p.type === "audio" || p.type === "file") return `[${p.type}]`;
  return `[${p.type}]`;
}
const msgText = (m: NormalizedMessage): string => (m.content ?? []).map(partText).join("\n");

function badgeClass(status: RequestView["status"]): string {
  if (status === "completed") return "border-success/30 bg-success/10 text-success";
  if (status === "streaming") return "border-primary/35 bg-primary/10 text-primary";
  if (status === "error") return "border-destructive/35 bg-destructive/10 text-destructive";
  return "border-warning/35 bg-warning/10 text-warning";
}

function rowClass(requestId: string): string {
  return requestId === selectedId
    ? "border-primary/35 bg-primary/10"
    : "border-transparent hover:border-border hover:bg-accent/45";
}

function statusDotClass(status: RequestView["status"]): string {
  if (status === "completed") return "border-success/40 bg-success";
  if (status === "streaming") return "border-primary/40 bg-primary";
  if (status === "error") return "border-destructive/40 bg-destructive";
  return "border-warning/40 bg-warning";
}

function tabClass(tab: "overview" | "logs" | "connect"): string {
  return view === tab
    ? "bg-background text-foreground shadow-sm"
    : "text-muted-foreground hover:text-foreground";
}
</script>

<div class="flex h-screen flex-col bg-background text-foreground">
  <header class="flex h-14 shrink-0 items-center gap-4 border-b bg-card px-5">
    <div class="flex items-baseline gap-1">
      <span class="text-[15px] font-semibold tracking-normal">LLM</span>
      <span class="text-[15px] font-semibold tracking-normal text-primary">Peek</span>
    </div>

    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        class={`h-2 w-2 rounded-full ${connected ? "bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.12)]" : "bg-muted-foreground"}`}
      ></span>
      <span>{connected ? "live" : "reconnecting..."}</span>
    </div>

    <nav class="ml-3 rounded-md bg-muted p-1" aria-label="Dashboard views">
      <button
        class={`h-8 rounded-sm px-3 text-sm font-medium transition ${tabClass("overview")}`}
        type="button"
        onclick={() => (activeTab = "overview")}
      >
        Overview
      </button>
      <button
        class={`h-8 rounded-sm px-3 text-sm font-medium transition ${tabClass("logs")}`}
        type="button"
        onclick={() => (activeTab = "logs")}
      >
        Logs
      </button>
      <button
        class={`h-8 rounded-sm px-3 text-sm font-medium transition ${tabClass("connect")}`}
        type="button"
        onclick={() => (activeTab = "connect")}
      >
        Connect
      </button>
    </nav>

    <span class="ml-auto text-xs text-muted-foreground">
      {order.length} request{order.length === 1 ? "" : "s"}
    </span>
  </header>

  {#snippet cmd(text: string, id: string)}
    <div class="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
      <code class="min-w-0 truncate font-mono text-sm">{text}</code>
      <button
        class="shrink-0 rounded border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
        type="button"
        onclick={() => copy(text, id)}
      >
        {copied === id ? "Copied" : "Copy"}
      </button>
    </div>
  {/snippet}

  {#snippet connectPanel()}
    <section class="h-full overflow-y-auto p-5">
      <div class="mx-auto max-w-3xl">
        <div class="flex items-center gap-3">
          <h1 class="text-lg font-semibold">Connect your app</h1>
          <span
            class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
          >
            <span class={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-muted-foreground"}`}
            ></span>
            {connected ? "listening" : "reconnecting"}
          </span>
        </div>
        <p class="mt-1 text-sm text-muted-foreground">
          Two ways to capture LLM calls. Pick the one that matches what you're running; both stream here live.
        </p>

        <div class="mt-5 grid gap-4 md:grid-cols-2">
          <div class="flex flex-col rounded-md border bg-card p-4">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-primary">
              Option 1 · Node app
            </div>
            <h2 class="mt-1 text-sm font-semibold">Import it</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              For a Node app you can edit. Add one line, as early as possible, before your LLM SDK
              loads. No certificates, no config.
            </p>
            <div class="mt-3">{@render cmd('import "llmpeek";', "import")}</div>
            <p class="mt-3 text-xs text-muted-foreground">
              Next.js: import from <code class="font-mono">instrumentation.ts</code> instead (see the README).
            </p>
          </div>

          <div class="flex flex-col rounded-md border bg-card p-4">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-primary">
              Option 2 · Any language
            </div>
            <h2 class="mt-1 text-sm font-semibold">Run the proxy</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              Python, curl, Go, Ruby, anything. Start the proxy, then source the env file in the shell
              that runs your app.
            </p>
            <div class="mt-3 space-y-2">
              <div class="flex items-start gap-2">
                <span
                  class="mt-2 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] text-muted-foreground"
                >1</span>
                <div class="min-w-0 flex-1">{@render cmd("npx llmpeek", "npx")}</div>
              </div>
              <div class="flex items-start gap-2">
                <span
                  class="mt-2 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] text-muted-foreground"
                >2</span>
                <div class="min-w-0 flex-1">{@render cmd("source .llmpeek/env.sh", "source")}</div>
              </div>
            </div>
            <p class="mt-3 text-xs text-muted-foreground">
              Only known LLM hosts are decrypted; all other traffic is tunneled through untouched.
            </p>
          </div>
        </div>

        <p class="mt-5 text-xs text-muted-foreground">
          Local-only: nothing leaves your machine. Capture is off in production and CI by default.
        </p>
      </div>
    </section>
  {/snippet}

  <main class="min-h-0 flex-1">
    {#if view === "connect"}
      {@render connectPanel()}
    {:else if view === "overview"}
      <section class="grid h-full grid-rows-[auto_1fr] gap-5 overflow-y-auto p-5">
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div class="rounded-md border bg-card p-4">
            <div class="text-xs font-medium text-muted-foreground">Requests</div>
            <div class="mt-2 text-2xl font-semibold">{rows.length}</div>
          </div>
          <div class="rounded-md border bg-card p-4">
            <div class="text-xs font-medium text-muted-foreground">Active</div>
            <div class="mt-2 text-2xl font-semibold text-primary">{activeRows.length}</div>
          </div>
          <div class="rounded-md border bg-card p-4">
            <div class="text-xs font-medium text-muted-foreground">Completed</div>
            <div class="mt-2 text-2xl font-semibold text-success">{completedRows.length}</div>
          </div>
          <div class="rounded-md border bg-card p-4">
            <div class="text-xs font-medium text-muted-foreground">Errors</div>
            <div class="mt-2 text-2xl font-semibold text-destructive">{errorRows.length}</div>
          </div>
          <div class="rounded-md border bg-card p-4">
            <div class="text-xs font-medium text-muted-foreground">Avg Latency</div>
            <div class="mt-2 text-2xl font-semibold">{ms(averageLatency)}</div>
          </div>
        </div>

        <div class="grid min-h-0 gap-5 xl:grid-cols-[1fr_320px]">
          <section class="min-h-0 rounded-md border bg-card">
            <div class="flex h-12 items-center justify-between border-b px-4">
              <h2 class="text-sm font-semibold">Recent Activity</h2>
              <button
                class="h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
                type="button"
                onclick={() => (activeTab = "logs")}
              >
                View logs
              </button>
            </div>

            <div class="divide-y">
              {#each latestRows as r (r.requestId)}
                <button
                  class="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 text-left transition hover:bg-accent/40"
                  type="button"
                  onclick={() => {
                    selectedId = r.requestId;
                    activeTab = "logs";
                  }}
                >
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-medium">
                      {r.model ?? r.provider ?? "unknown model"}
                    </span>
                    <span class="mt-1 block truncate text-xs text-muted-foreground">
                      {r.provider ?? "unknown"} / {r.operation ?? "request"} {r.path ?? ""}
                    </span>
                  </span>
                  <span class="flex items-center gap-3">
                    <span class="text-xs text-muted-foreground">{ms(r.totalMs ?? r.ttftMs)}</span>
                    <span
                      class={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-normal ${badgeClass(r.status)}`}
                    >
                      {r.status}
                    </span>
                  </span>
                </button>
              {/each}

              {#if latestRows.length === 0}
                <div class="px-4 py-10 text-sm text-muted-foreground">Waiting for LLM calls...</div>
              {/if}
            </div>
          </section>

          <aside class="rounded-md border bg-card p-4">
            <h2 class="text-sm font-semibold">Session</h2>
            <dl class="mt-4 space-y-3 text-sm">
              <div class="flex items-center justify-between gap-4">
                <dt class="text-muted-foreground">Connection</dt>
                <dd class="font-medium">{connected ? "Live" : "Reconnecting"}</dd>
              </div>
              <div class="flex items-center justify-between gap-4">
                <dt class="text-muted-foreground">Total cost</dt>
                <dd class="font-medium">{money(totalCost)}</dd>
              </div>
              <div class="flex items-center justify-between gap-4">
                <dt class="text-muted-foreground">Streaming</dt>
                <dd class="font-medium">{rows.filter((r) => r.streamed).length}</dd>
              </div>
              <div class="flex items-center justify-between gap-4">
                <dt class="text-muted-foreground">Selected</dt>
                <dd class="max-w-40 truncate font-mono text-xs">{selected?.requestId ?? "-"}</dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>
    {:else}
      <section class="grid h-full min-h-0 grid-cols-[340px_1fr]">
        <aside class="min-h-0 overflow-y-auto border-r bg-card/60">
          <div class="sticky top-0 z-10 border-b bg-card/95 px-4 py-3 backdrop-blur">
            <h2 class="text-sm font-semibold">Request Logs</h2>
            <p class="mt-1 text-xs text-muted-foreground">Live provider calls and stream events</p>
          </div>

          <ul class="space-y-1 p-2" bind:this={requestLog}>
            {#each rows as r (r.requestId)}
              <li>
                <button
                  class={`w-full rounded-md border px-3 py-2.5 text-left transition ${rowClass(r.requestId)}`}
                  type="button"
                  onclick={() => (selectedId = r.requestId)}
                >
                  <span class="flex items-center gap-2">
                    <span
                      class="group/status relative grid h-5 w-5 shrink-0 place-items-center"
                      aria-label={r.status}
                    >
                      <span
                        class={`h-2.5 w-2.5 rounded-full border ${statusDotClass(r.status)}`}
                      ></span>
                      <span
                        class="pointer-events-none absolute left-1/2 top-full z-20 mt-2 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground opacity-0 shadow-sm transition group-hover/status:opacity-100"
                      >
                        {r.status}
                      </span>
                    </span>
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">
                      {r.model ?? r.provider ?? "unknown"}
                    </span>
                  </span>
                  <span class="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span class="truncate">{tokens(r)} tokens</span>
                    <span class="shrink-0">{ms(r.totalMs ?? r.ttftMs)}</span>
                  </span>
                </button>
              </li>
            {/each}
            {#if rows.length === 0}
              <li class="px-3 py-6 text-sm text-muted-foreground">Waiting for LLM calls...</li>
            {/if}
          </ul>
        </aside>

        <section class="min-h-0 overflow-y-auto p-5">
          {#if selected}
            <div class="rounded-md border bg-card">
              <div class="border-b p-4">
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-normal ${badgeClass(selected.status)}`}
                  >
                    {selected.status}
                  </span>
                  <b class="text-sm">{selected.provider}</b>
                  <span class="text-sm text-muted-foreground">{selected.model ?? "unknown model"}</span>
                  <span class="text-sm text-muted-foreground">{selected.operation ?? "request"}</span>
                </div>
                <code class="mt-2 block truncate font-mono text-xs text-muted-foreground">
                  {selected.path}
                </code>
              </div>

              <div class="grid gap-3 border-b p-4 text-sm sm:grid-cols-2 xl:grid-cols-5">
                <div>
                  <div class="text-xs text-muted-foreground">Tokens</div>
                  <div class="mt-1 font-medium">{tokens(selected)}</div>
                </div>
                <div>
                  <div class="text-xs text-muted-foreground">TTFT</div>
                  <div class="mt-1 font-medium">{ms(selected.ttftMs)}</div>
                </div>
                <div>
                  <div class="text-xs text-muted-foreground">Total</div>
                  <div class="mt-1 font-medium">{ms(selected.totalMs)}</div>
                </div>
                <div>
                  <div class="text-xs text-muted-foreground">Finish</div>
                  <div class="mt-1 font-medium">{selected.finishReason ?? "-"}</div>
                </div>
                <div>
                  <div class="text-xs text-muted-foreground">Cost</div>
                  <div class="mt-1 font-medium">{money(selected.cost?.totalCost ?? 0)}</div>
                </div>
              </div>

              <div class="space-y-5 p-4">
                {#if selected.errorMessage}
                  <pre class="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-sm leading-6 text-destructive">{selected.errorMessage}</pre>
                {/if}

                <section>
                  <h3 class="mb-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                    Prompt
                  </h3>
                  <div class="space-y-3">
                    {#each selected.promptMessages as m}
                      <div class="rounded-md border bg-background p-3">
                        <span class="text-[11px] font-semibold uppercase tracking-normal text-primary">
                          {m.role}
                        </span>
                        <pre class="mt-2 whitespace-pre-wrap break-words font-mono text-sm leading-6">{msgText(m)}</pre>
                      </div>
                    {/each}
                    {#if selected.promptMessages.length === 0}
                      <div class="text-sm text-muted-foreground">-</div>
                    {/if}
                  </div>
                </section>

                <section>
                  <h3 class="mb-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                    Response
                  </h3>
                  {#if selected.status === "streaming"}
                    <pre class="whitespace-pre-wrap break-words rounded-md border bg-background p-3 font-mono text-sm leading-6">{selected.streamingText}<span class="animate-pulse text-primary">|</span></pre>
                  {:else if selected.responseMessages.length}
                    <div class="space-y-3">
                      {#each selected.responseMessages as m}
                        <div class="rounded-md border bg-background p-3">
                          <span class="text-[11px] font-semibold uppercase tracking-normal text-primary">
                            {m.role}
                          </span>
                          <pre class="mt-2 whitespace-pre-wrap break-words font-mono text-sm leading-6">{msgText(m)}</pre>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div class="text-sm text-muted-foreground">-</div>
                  {/if}
                </section>
              </div>
            </div>
          {:else}
            <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a request to inspect its prompt, streaming output, and tokens.
            </div>
          {/if}
        </section>
      </section>
    {/if}
  </main>
</div>
