# Ollama on Intel Core Ultra (Lunar Lake)

Tuning notes for running `ocode` against local Ollama on this machine. Every number
below was measured here, not estimated — reproduce them with the commands in
[Verifying](#verifying).

## The machine

| | |
|---|---|
| CPU | Intel Core Ultra 5 226V (Lunar Lake), 8 cores / 8 threads |
| GPU | Intel Arc 130V (Xe2), driver 32.0.101.8132 |
| NPU | Intel AI Boost |
| RAM | 15.5 GB — **shared** between CPU and iGPU |
| Ollama | 0.33.1 |

Lunar Lake has no discrete VRAM: the iGPU carves its memory out of the same
15.5 GB the OS uses. "VRAM" in Ollama's output is therefore a slice of system
RAM, and the model, the KV cache, and everything else you have open compete for
one pool.

The scheduler reports the pool as, from `server.log`:

```
gpu memory id=0 library=Vulkan available="7.7 GiB" free="8.2 GiB" minimum="457.0 MiB"
Vulkan0 : Intel(R) Arc(TM) 130V GPU (8GB) (9074 MiB, 8364 MiB free)
```

So the real budget for **model weights + KV cache + compute buffers** is about
**7.7 GiB**. Everything in this document is sized against that number.

## The one setting that matters

Ollama detected the Arc GPU and then deliberately threw it away. From
`%LOCALAPPDATA%\Ollama\server.log`:

```
msg="dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1"
     id=0 library=Vulkan compute=0.0 name=Vulkan0
     description="Intel(R) Arc(TM) 130V GPU (8GB)"
```

Ollama ships the Vulkan backend (`lib/ollama/vulkan/ggml-vulkan.dll` is present
and Vulkan is enabled by default) but skips integrated GPUs unless told
otherwise. Setting `OLLAMA_IGPU_ENABLE=1` moved the model onto the GPU:

| qwen2.5-coder:7b | CPU only | iGPU enabled |
|---|---|---|
| Prompt processing | 5.6 tok/s | **29.5 tok/s** (5.3x) |
| Generation | 7.3 tok/s | **10.7 tok/s** |
| Placement | CPU | 4.4 GB on GPU |

Prompt processing is the figure that governs how long the agent appears to
"hang", because every turn re-reads a system prompt, tool schemas and project
context before producing a token. A full fix-and-verify task through `ocode` went
from **149s → 34s → 16-23s** across the prompt-slimming work and this change.

## Recommended environment

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_IGPU_ENABLE','1','User')       # essential
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE','q8_0','User')  # smaller KV cache
[Environment]::SetEnvironmentVariable('OLLAMA_CONTEXT_LENGTH','16384','User')
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE','10m','User')
[Environment]::SetEnvironmentVariable('OLLAMA_MAX_LOADED_MODELS','1','User')
```

This table is also `TUNED_ENV` in `src/env/ollama-tuning.js`, which is what
`ocode doctor` compares against — change the two together, or the doctor will
report drift against a value this document no longer recommends.

These are already applied on this machine. Then **restart the tray app** — see
[the gotcha below](#windows-gotcha-the-tray-app-and-environment-variables) —
and confirm the server picked them up:

```powershell
(Select-String -Path "$env:LOCALAPPDATA\Ollama\server.log" -Pattern 'server config' |
  Select-Object -Last 1).Line -replace '.*env="map\[','' -split ' ' |
  Where-Object { $_ -match 'CONTEXT_LENGTH|IGPU|KV_CACHE|KEEP_ALIVE|MAX_LOADED|NUM_PARALLEL' }
```

| Variable | Why |
|---|---|
| `OLLAMA_IGPU_ENABLE=1` | Stops Ollama discarding the Arc iGPU. Without it everything runs on CPU. |
| `OLLAMA_KV_CACHE_TYPE=q8_0` | Measured 4.43 GB vs 4.64 GB with no throughput cost. On shared memory, every 200 MB counts. Also the reason flash attention switches on — see below. |
| `OLLAMA_CONTEXT_LENGTH=16384` | Ollama defaults to 4096, which is too small once tool schemas and project context are in the prompt. On 0.33.0, 16384 costs only ~8% prompt throughput and 240 MB (see below). |
| `OLLAMA_KEEP_ALIVE=10m` | Ollama evicts an idle model after ~5 minutes; reloading a 7B from disk here took **73s** cold. 30m was the earlier value and it is too long on shared memory: the 7B holds **4.67 GB** of the 15.5 GB pool for half an hour after the last turn, and the machine noticeably swaps. 10m keeps it warm across active work and gives the memory back when you walk away. |
| `OLLAMA_MAX_LOADED_MODELS=1` | Defaults to 0 = automatic, which permits several models resident at once. On a 7.7 GiB shared pool a second model means swapping. Pin it to 1. |

`OLLAMA_NUM_PARALLEL` already resolves to 1 here and needs no setting; raising
it divides the context window between slots and multiplies the KV cache.

### Leave `OLLAMA_FLASH_ATTENTION` unset — but it is *not* disabled

This reversed on 0.33.0. The variable is intentionally absent, and the server
config line duly reports `OLLAMA_FLASH_ATTENTION:false` — yet flash attention
still runs, because Ollama now passes `--flash-attn auto` and llama.cpp turns it
on itself:

```
llama_init_from_model: enabling flash_attn since it is required for quantized V cache
llama_context: flash_attn = enabled
```

`OLLAMA_KV_CACHE_TYPE=q8_0` is what forces it. So you get flash attention for
free, and the env var is only a manual override you do not need.

**On 0.32.15 forcing `OLLAMA_FLASH_ATTENTION=1` crashed the runner** with
`llama-server process has terminated: exit status 0xe06d7363`, after which
Ollama silently fell back to CPU — a mysterious 15x slowdown rather than an
error. That is fixed: the current log has **zero** `0xe06d7363` occurrences
across two days of continuous use with flash attention active. Check your own
before assuming either way:

```powershell
Select-String -Path "$env:LOCALAPPDATA\Ollama\server.log" -Pattern '0xe06d7363|has terminated'
```

Setting the variable explicitly still buys nothing over `auto`, so leave it out.

### Windows gotcha: the tray app and environment variables

`ollama app.exe` reads these variables when it starts, and a running process
does not see a variable you set afterwards. After changing them either **sign
out and back in**, or restart with the values in scope:

```powershell
Get-Process ollama*,'ollama app' | Stop-Process -Force
'OLLAMA_IGPU_ENABLE','OLLAMA_KV_CACHE_TYPE','OLLAMA_CONTEXT_LENGTH','OLLAMA_KEEP_ALIVE' |
  ForEach-Object { $v = [Environment]::GetEnvironmentVariable($_,'User'); if ($v) { Set-Item "Env:$_" $v } }
Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
```

This bit us during setup: the variable was persisted correctly, the tray app was
restarted from a shell that predated it, and the GPU quietly stayed off — a task
that takes 16s ran for 228s.

## Context size

Re-measured on **0.33.1**, on the iGPU, with a ~1,800-token prompt so that
prompt processing is actually exercised. Both models were confirmed fully
offloaded (`offloaded 29/29 layers to GPU`):

| Model | `num_ctx` | Prompt tok/s | Generation tok/s | VRAM | Load |
|---|---|---|---|---|---|
| qwen2.5-coder:7b | 8192 | 157.1 | 6.0 | 4.43 GB | 72.8s |
| **qwen2.5-coder:7b** | **16384** | **157.7** | **6.0** | **4.67 GB** | 30.3s |
| qwen3:1.7b | 8192 | 450.0 | 19.7 | 1.61 GB | 11.9s |
| qwen3:1.7b | 16384 | 446.9 | 19.6 | 2.09 GB | 9.1s |

**Doubling the window is now free.** On 0.33.1 the 8192 → 16384 step costs 0.4%
prompt throughput and 240 MB on the 7B, and 0.7% on the 1.7b — where 0.33.0 put
it at 8%. There is no longer a throughput argument for a small window.

These absolute numbers are lower than the 0.33.0 table below them because the
machine was under memory load when they were taken (available RAM ~200 MB, see
[Memory pressure](#memory-pressure)). Treat the *ratios* as the finding.

> **`bench-ollama.ps1` can mislabel the last row `<- CPU ONLY`.** It reads
> `size_vram` from `/api/ps` after the request, and if the model has already
> been evicted by then the field reads 0. Confirm against the log before
> believing it — `offloaded N/N layers to GPU` is the real answer:
>
> ```powershell
> Select-String -Path "$env:LOCALAPPDATA\Ollama\server.log" -Pattern 'offloaded|using device' | Select-Object -Last 3
> ```

For reference, the earlier 0.33.0 measurement of the same 7B:

| `num_ctx` | Prompt tok/s | Generation tok/s | VRAM |
|---|---|---|---|
| 8192 | 185.3 | 8.0 | 4.43 GB |
| **16384** | **171.0** | **7.5** | **4.67 GB** |
| 32768 | 169.6 | 6.8 | 5.15 GB |

**16384 is the sweet spot on 0.33.0.** Doubling the window from 8192 costs 8%
prompt throughput, 6% generation and 240 MB — where on 0.32.15 the same step
cost a third of generation speed. Flash attention (now active, see above) is
what changed: attention no longer scales the way it did, so a longer window is
close to free.

32768 still fits inside the 7.7 GiB pool with room to spare, but generation is
15% down. Reach for it per-request rather than globally — `ocode` sends `num_ctx`
per call, so a single large-file task can ask for it without slowing every turn.

These numbers moved a lot between two Ollama releases on identical hardware.
Re-run the [benchmark](#verifying) after an Ollama upgrade rather than trusting
this table.

## Models for 16 GB shared memory

Two limits bind, and which one bites depends on what else is open. The **7.7
GiB the Vulkan scheduler will hand to the iGPU** is the ceiling on an idle
machine; with an editor and a browser running, **free system RAM runs out
first** — the scheduler reports `system_limited=true` while the GPU still shows
free memory, because on shared memory the iGPU allocation comes out of the same
15.5 GB. Size against the smaller of the two.

Weights, KV cache and compute buffers all come out of that budget, so at 16k
context:

```
7.7 GiB pool  −  ~0.5 GB KV cache  −  ~0.15 GB compute  ≈  7 GB for weights
```

Leave a margin and treat **~6 GB of weights as the practical ceiling**. A model
that exceeds the pool is not rejected — it is *partially* offloaded, and the
layers left on the CPU dominate the runtime. Exceed system RAM too and you swap,
which on shared memory is catastrophic (the log shows moments with 233 MB free).

Measured here, all on the iGPU:

| Model | Size | Prompt tok/s | Gen tok/s | Memory | Tool calling |
|---|---|---|---|---|---|
| `deepseek-coder:1.3b` | 0.8 GB | 291.0 | 57.9 | 1.5 GB | **no** |
| `llama3.2:3b` | 2.0 GB | 30.6 | 26.6 | 2.4 GB | yes |
| **`qwen2.5-coder:7b`** | 4.7 GB | 74.6 | 15.1 | 4.4 GB | yes |
| `deepcoder:14b` | 9.0 GB | not benchmarked | | ~9 GB | yes |

**Use `qwen2.5-coder:7b`.** It is the best balance here: real coding ability,
native tool calling, and it leaves ~10 GB for everything else.

`ocode` will also pick it for you — see [Automatic model selection](#automatic-model-selection).

Notes on the others:

- `deepseek-coder:1.3b` is dramatically faster but **has no tool-calling
  template** — Ollama rejects requests carrying tool schemas with
  `does not support tools`. `ocode` detects that and falls back to text-mode tool
  calls, but a 1.3B model is not reliable at driving an agent loop. Fine for
  autocomplete-style completion, not for this.
- `llama3.2:3b` supports tools and is quick, but is a general model rather than
  a coding one.
- `deepcoder:14b` at 9 GB **does not fit the 7.7 GiB GPU pool at all.** It will
  be split, with the remainder on the CPU at ~7 tok/s prompt processing, and it
  is a reasoning model that spends tokens thinking before it acts — the worst
  combination for an agent loop that re-reads a prompt every turn. Delete it
  unless you have a specific use for it: `ollama rm deepcoder:14b`.

Worth trying if you want to experiment (pull sizes are approximate):

| Model | Approx. size | Fits? | Why |
|---|---|---|---|
| `qwen2.5-coder:7b-instruct-q5_K_M` | ~5.4 GB | yes | Same model, less quantization damage; ~15% slower |
| `qwen3:8b` | ~5.2 GB | yes | Newer generation, strong tool calling. Send `think: false` — reasoning tokens are dead weight in an agent loop |
| `qwen2.5-coder:14b` | ~9 GB | **no** | Over the pool; partially offloaded to CPU |

Anything at 14B and above is out on this machine, whatever the RAM says — the
GPU pool is the limit. The 30B-class coder models (`qwen3-coder:30b` is ~18 GB
at Q4) are not close.

Before pulling a several-GB model, check it against the pool:

```powershell
# weights must land under ~6 GB
(Invoke-RestMethod 'http://127.0.0.1:11434/api/tags').models |
  Select-Object name, @{n='GB';e={[math]::Round($_.size/1GB,2)}} | Sort-Object GB
```

Check tool support before committing to a model:

```powershell
(Invoke-RestMethod 'http://127.0.0.1:11434/api/show' -Method Post `
  -Body (@{model='qwen2.5-coder:7b'} | ConvertTo-Json) `
  -ContentType 'application/json').capabilities
```

`tools` must appear in the list.

## Automatic model selection

`ocode` picks a model when the configured one cannot do the job. The rules live in
`src/model/router.js`; the reasoning is entirely about this hardware.

**Switching is expensive here, so the router is deliberately reluctant.** A 7B
reload costs ~96s, and the stable prompt prefix that lets Ollama reuse its KV
cache is worth ~112s against ~1s on a follow-up turn. Both are discarded by a
switch.

The obvious optimisation — keep a small model resident alongside the coder so
switching is free — **was measured and does not work**:

```
model predicted to exceed available memory, evicting
predicted="3.6 GiB" available="2.5 GiB" gpu_free="3.5 GiB"
system_free="2.5 GiB" system_limited=true
```

Note `system_limited=true` while the GPU still had 3.5 GiB free. On shared
memory the iGPU allocation competes with the OS for the same 15.5 GB, so with
an editor and a browser open the *system* runs out first. `llama3.2:3b` at
16384 context is 2.95 GB — raising `OLLAMA_CONTEXT_LENGTH` made it too large to
sit beside the 7B. Setting `OLLAMA_MAX_LOADED_MODELS=2` does not change this;
the scheduler evicts anyway.

So the policy is:

| Situation | Action |
|---|---|
| Current model has no tool-calling template | **Switch** — worth a reload; text-mode calls are markedly worse |
| Current model's context cannot fit the turn | **Switch** |
| Current model works, a faster one exists but is not loaded | **Stay** — a reload costs more than it saves |
| Current model works, a faster one is already resident or hosted | Switch only if `routing.speed` is on |
| You chose the model with `--model` or `/model` | **Never** overridden |

Ranking among capable models is "the largest that **fits**", not the largest.
Weights above `routing.maxModelBytes` (derived from total RAM when unset) are
penalised, because an oversized model is partially offloaded and the CPU layers
then dominate — `deepcoder:14b` at 9 GB is the slowest option here, not the
best. Advertised context length is a gate, never a bonus: it scored a general
3B advertising 131k over a 7B coder advertising 32k, on a machine that can
afford neither window.

Configure it in `~/.ollamacode/config.json`:

```json
{
  "routing": {
    "enabled": true,
    "speed": false,
    "allowRemote": false,
    "maxModelBytes": null
  }
}
```

`allowRemote` is off by default and never inferred: routing to HuggingFace
sends your code off this machine, which has to be a deliberate choice rather
than a performance heuristic.

Every switch is announced with its reason and whether it costs a load:

```
switching to qwen2.5-coder:7b: deepseek-coder:1.3b has no tool-calling template — this needs a model load
```

A provider joins in by implementing `listModels()`; `modelInfo()` and
`residentModels()` are used when present, so a plugin in
`~/.ollamacode/providers/` participates without knowing the router exists.

## The NPU

`Intel(R) AI Boost` is the NPU. **Ollama cannot use it.** Ollama's accelerator
backends are CUDA (NVIDIA), ROCm (AMD), Metal (Apple) and Vulkan — there is no
NPU path. Reaching the NPU means a different runtime (OpenVINO GenAI or
`ipex-llm`), which does not speak Ollama's API and so would need a `ocode` provider
plugin (`~/.ollamacode/providers/*.js`). The Arc iGPU is the right target here.

## How `ocode` adapts

`ocode` reads the backend's real capabilities rather than assuming, in
`agent/workspace.js` and `model/providers/ollama.js`:

- Queries `/api/show` for the model's context window and whether it advertises
  `tools`.
- Queries `/api/ps` for `size_vram`; if it is 0 the backend is CPU-only and `ocode`
  switches to a lean prompt (compact schemas, core tool set) — about **1,200
  tokens of overhead instead of 4,600**.
- Gathers project context **once per session** and reuses it byte-for-byte, so
  Ollama can reuse its KV cache. Follow-up turns measured **~1s instead of
  ~112s**.
- Sends `keep_alive` on every request, and prewarms in the background while you
  type your first message in `ocode chat`.
- **Explains a slow turn while it is happening.** The status line ticks with a
  spinner and elapsed seconds, and past ~8s it says what it is waiting for,
  using the same probe results as above:

  ```
  ⠙ Pondering… 10s · reading the prompt
  ⠴ Mulling it over… 30s · qwen2.5-coder:7b likely loading — cold start ~90s
  ⠧ Deliberating… 44s · on CPU, no GPU offload — expect minutes
  ```

  A cold load and a genuine hang look identical without this. If you see the
  CPU line, the iGPU is not being used — go back to
  [the one setting that matters](#the-one-setting-that-matters).

- **Shows text arriving before the line is finished.** Output is committed a
  line at a time, so at 7.5 tok/s a long paragraph left the screen static for
  ~16s and a fenced code block for a minute or more. The same transient row now
  carries a live tail while text is buffered:

  ```
  ⠙ │ …and returns an empty dict when the file is missing  12s
  ⠹ writing code block… 14 lines  31s
  ```

  Code blocks are still held back whole — that is what lets a fabricated tool
  call be withheld from the screen — so inside a fence you get the line counter
  rather than the contents.

- **Distinguishes slow from stopped.** A gap of ten seconds between tokens is
  three orders of magnitude off the expected cadence, so it is called out
  instead of left to guess at:

  ```
  ⠸ no tokens for 12s · Ctrl-C to cancel
  ```

  While that line is *not* showing, the model is working and cancelling will
  throw away real progress.

The wording lives in `src/ui/status-narrator.js` (pure, unit-tested); the
`--tui` front-end has its own status bar and shows a plain label instead.

Because of the CPU-only check, enabling the iGPU also lets `ocode` spend more of
the context window on useful content. Nothing needs configuring in `ocode`.

## Maintenance

### Interrupted pulls are never cleaned up

Ollama prunes unreferenced blobs at startup, but it **leaves `*-partial*`
behind**. A pull that dies part-way — a dropped connection, a full disk, a
Ctrl-C — leaves its bytes on disk permanently, referenced by no manifest and
reported by no `ollama list`.

Found here: **20.1 GB across 34 files**, from two abandoned pulls, against a
28.8 GB model store whose four real models account for only 8.7 GB.

Nothing warns you, because the size is invisible to every normal command. Check
the store against its manifests rather than trusting `ollama list`:

```powershell
$m = "$env:USERPROFILE\.ollama\models"
Get-ChildItem "$m\blobs" -File | Where-Object Name -like '*partial*' |
  Measure-Object Length -Sum |
  ForEach-Object { "{0} files, {1:N2} GB" -f $_.Count, ($_.Sum/1GB) }
```

Delete them only when no pull is running — a `-partial` belonging to a live
download is exactly what it looks like:

```powershell
Get-Process ollama*, 'ollama app' | Stop-Process -Force
Get-ChildItem "$env:USERPROFILE\.ollama\models\blobs" -File |
  Where-Object Name -like '*partial*' | Remove-Item -Force
Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
```

`ocode doctor` reports this as `ollama-disk`, together with free space on the
model volume. The deletion is deliberately **not** offered as a `--fix`.

### `ocode doctor` checks the tuning

Four checks in `src/env/ollama-tuning.js`, so the configuration cannot drift
unnoticed the way it did here — the prescribed 16384 context had silently been
sitting at 2048:

| Check | Warns when | `--fix` |
|---|---|---|
| `ollama-env` | a variable drifts from `TUNED_ENV` | `setx` to the tuned value (then restart the tray app) |
| `ollama-disk` | `*-partial*` blobs exist, or < 15 GB free | none — reports the reclaimable bytes |
| `context-fit` | `agent.contextBudget` ≥ `agent.contextWindow` | lowers the budget to 70% of the window |
| `model-tools` | the active model has no tool template | none — the fix is a model choice |

The `ollama-env` check reads `process.env`, so it sees what **this shell**
inherited. A shell opened before the variables were set will report drift that
is already fixed — which is the same [tray-app
gotcha](#windows-gotcha-the-tray-app-and-environment-variables) in a different
costume. Open a new terminal before believing it.

## Memory pressure

The 7.7 GiB GPU pool is carved from the same 15.5 GB the OS uses, so a resident
model is not "on the GPU" in any sense that spares system RAM — it is simply
gone from the pool. Two things follow.

**`OLLAMA_KEEP_ALIVE` is a memory setting, not just a latency one.** At `30m`,
qwen2.5-coder:7b holds **4.67 GB** for half an hour after your last turn. On a
loaded machine that was the difference between 446 MB and 5.3 GB of available
memory — measured, by unloading it:

```powershell
# what is resident right now, and what it costs
(Invoke-RestMethod 'http://127.0.0.1:11434/api/ps').models |
  ForEach-Object { '{0} {1:N2} GB' -f $_.name, ($_.size/1GB) }

# hand it back immediately
$b = @{ model = 'qwen2.5-coder:7b'; keep_alive = 0 } | ConvertTo-Json
Invoke-RestMethod 'http://127.0.0.1:11434/api/generate' -Method Post -Body $b -ContentType 'application/json'
```

`10m` is the compromise this document now recommends: warm across active work,
released when you walk away.

**`ocode` overrides the server default.** `agent.keepAlive` in
`~/.ollamacode/config.json` is sent per request, so changing
`OLLAMA_KEEP_ALIVE` alone changes nothing for `ocode`. Change both.

**Docker is the other tenant.** `vmmemWSL` held 0.7–1.8 GB throughout, and
Docker Desktop's `docker_data.vhdx` had grown to 103.66 GB on disk while
containing 5.8 GB of actual data — VHDX files expand and never shrink on their
own. Compacting it (Docker stopped, `wsl --shutdown`, then an elevated
`diskpart` → `select vdisk` / `attach vdisk readonly` / `compact vdisk`)
returned **91.6 GB**. Run `fstrim` inside the VM first or the compact has
nothing to reclaim:

```powershell
wsl -d docker-desktop -e fstrim -v /mnt/docker-desktop-disk
```

## Verifying

Is the GPU actually being used?

```powershell
# After any request; size_vram > 0 means GPU.
(Invoke-RestMethod 'http://127.0.0.1:11434/api/ps').models |
  ForEach-Object { '{0} vram {1:N2}GB' -f $_.name, ($_.size_vram/1GB) }
```

Throughput — every table in this document came from this script:

```powershell
./scripts/bench-ollama.ps1                                          # defaults
./scripts/bench-ollama.ps1 -Model qwen2.5-coder:7b -Ctx 8192,16384,32768
```

It unloads between rows (`num_ctx` only applies at load), uses a ~1,800-token
prompt so prompt processing is actually measured, and flags any row that landed
on the CPU. Budget ~10s of reload per row.

Re-run it after an Ollama upgrade. The 0.32.15 → 0.33.0 step more than doubled
prompt throughput here and changed which context size is optimal.

What the server decided about your GPU:

```powershell
Select-String -Path "$env:LOCALAPPDATA\Ollama\server.log" -Pattern 'igpu|Vulkan|dropping' |
  Select-Object -Last 5
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `size_vram` is 0 | `OLLAMA_IGPU_ENABLE` not set, **or** the server was started before it was set. Restart per the gotcha above. |
| Sudden 10x slowdown, `size_vram` drops to 0 | The runner crashed and fell back to CPU. Check the log for `0xe06d7363`. On 0.32.15 this was caused by forcing `OLLAMA_FLASH_ATTENTION=1`; it has not recurred on 0.33.0. |
| Model loads but is slow, `size_vram` < the model's size | Partial offload — the model is larger than the 7.7 GiB pool and the remainder runs on CPU. Use a smaller model; see [Models](#models-for-16-gb-shared-memory). |
| Second model load evicts the first, or both thrash | `OLLAMA_MAX_LOADED_MODELS` left at 0 (automatic). Pin it to 1. |
| `does not support tools` (HTTP 400) | The model has no tool template. Check `capabilities`; `ocode` falls back to text-mode calls automatically. |
| Very slow with free memory low in the log | Swapping. Close applications or use a smaller model — shared memory means the model competes with everything else. |
| First request takes ~96s | Model loading from disk. `OLLAMA_KEEP_ALIVE=30m` prevents repeats. |

## Summary

1. `OLLAMA_IGPU_ENABLE=1` — the single biggest win, 5.3x prompt processing.
2. `qwen2.5-coder:7b` is the right model here: it fits the GPU pool with room
   for a 16k context, and it does native tool calling.
3. The real limit is the **7.7 GiB iGPU pool**, not the 15.5 GB of RAM. Keep
   weights under ~6 GB; nothing at 14B or above qualifies.
4. `OLLAMA_CONTEXT_LENGTH=16384`. On 0.33.1 doubling the window costs 0.4%,
   not the 8% measured on 0.33.0 — there is no throughput argument left for a
   small window. Verify the server actually took it; the prescribed value had
   silently drifted to 2048.
5. Leave `OLLAMA_FLASH_ATTENTION` unset. It reports `false` but runs anyway,
   because `q8_0` KV cache requires it. The 0.32.15 crash no longer reproduces.
6. `OLLAMA_MAX_LOADED_MODELS=1` — a second resident model does not fit.
7. Restart the tray app *after* setting variables, or they are ignored.
8. The NPU is not reachable from Ollama; the Arc iGPU is the target.
9. `OLLAMA_KEEP_ALIVE` is a memory setting: at `30m` the 7B holds 4.67 GB of a
   shared 15.5 GB pool long after you stop typing. `10m`, in **both** the
   environment and `agent.keepAlive`, since `ocode` overrides the server default.
10. Check the model store for `*-partial*` blobs. Ollama never removes them and
    20.1 GB had accumulated invisibly here.
11. Run `ocode doctor` — `ollama-env`, `ollama-disk`, `context-fit` and
    `model-tools` exist so none of this drifts unnoticed again.
