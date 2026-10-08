<#
.SYNOPSIS
  Measure Ollama prompt/generation throughput and VRAM placement.

.DESCRIPTION
  The numbers in ollama.md were produced with this script. They moved
  substantially between Ollama 0.32.15 and 0.33.0 on identical hardware, so
  re-run it after an Ollama upgrade rather than trusting the table.

  Each measurement unloads the model first, because num_ctx only takes effect
  on load. Expect roughly a 10s reload per row.

.EXAMPLE
  ./scripts/bench-ollama.ps1
  ./scripts/bench-ollama.ps1 -Model qwen2.5-coder:7b -Ctx 8192,16384,32768
  ./scripts/bench-ollama.ps1 -Model llama3.2:3b -Ctx 8192
#>
param(
  [string]  $Model = 'qwen2.5-coder:7b',
  [int[]]   $Ctx   = @(8192, 16384),
  [int]     $Predict = 120,
  [string]  $Host_ = 'http://127.0.0.1:11434'
)

$ErrorActionPreference = 'Stop'

# ~1,800 tokens, so prompt processing is actually exercised. A short prompt
# measures almost nothing and is why early numbers here were misleading.
$filler = (1..90 | ForEach-Object {
  "// line ${_} - export function helper$_(a, b) { return a * $_ + b; }"
}) -join "`n"
$prompt = "$filler`n`nSummarize what the code above does in one sentence, then write a C# singleton class."

foreach ($c in $Ctx) {
  # Unload: num_ctx is applied at load time only.
  Invoke-RestMethod "$Host_/api/generate" -Method Post -ContentType 'application/json' `
    -Body (@{ model = $Model; keep_alive = 0 } | ConvertTo-Json) | Out-Null
  Start-Sleep -Seconds 3

  $body = @{
    model   = $Model
    prompt  = $prompt
    stream  = $false
    options = @{ num_ctx = $c; num_predict = $Predict }
  } | ConvertTo-Json

  $r = Invoke-RestMethod "$Host_/api/generate" -Method Post -Body $body `
        -ContentType 'application/json' -TimeoutSec 900

  # size_vram of 0 means the model fell back to CPU -- the result is not
  # comparable with a GPU row, so surface it rather than printing a bare number.
  $m = (Invoke-RestMethod "$Host_/api/ps").models |
         Where-Object { $_.model -eq $Model } | Select-Object -First 1
  $vram = if ($m) { $m.size_vram } else { 0 }

  '{0,-24} ctx {1,6}  prompt {2,7:N1} tok/s  gen {3,6:N1} tok/s  vram {4,5:N2} GB  load {5,5:N1}s{6}' -f `
    $Model, $c,
    ($r.prompt_eval_count / ($r.prompt_eval_duration / 1e9)),
    ($r.eval_count        / ($r.eval_duration        / 1e9)),
    ($vram / 1GB),
    ($r.load_duration / 1e9),
    $(if ($vram -eq 0) { '  <- CPU ONLY' } else { '' })
}
