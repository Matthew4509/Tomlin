# Video engine test (Videographer plan, phase 1). Run on the PC with the graphics card, in Windows PowerShell:
#   powershell -ExecutionPolicy Bypass -File video-engine-test.ps1 -Step fetch     (downloads, about 19 GB, see below)
#   powershell -ExecutionPolicy Bypass -File video-engine-test.ps1 -Step sd        (stable-diffusion.cpp, CLI)
#   powershell -ExecutionPolicy Bypass -File video-engine-test.ps1 -Step comfy     (ComfyUI over its HTTP API)
# Everything lives under -Root (default D:\video-test); nothing touches TOMLIN's own folders. Results go to
# <Root>\results.csv and the logs and clips to <Root>\out. Both engines make the same clip: Wan 2.1 T2V 1.3B, 832x480,
# 49 frames at 16 fps (about 3 s), 20 steps, cfg 6, euler, shift 3, seed 42.
param(
  [ValidateSet('fetch', 'sd', 'comfy')][string]$Step = 'sd',
  [string]$Root = 'D:\video-test',
  [int]$Frames = 49, [int]$Width = 832, [int]$Height = 480, [int]$Steps = 20, [int]$Seed = 42, [int]$Runs = 2
)
$ErrorActionPreference = 'Stop'
$Prompt = 'A red fox trots through fresh snow in a pine forest at sunrise, soft golden light, the camera follows it slowly'
$Negative = 'static, still image, blurry, low quality, distorted, deformed, extra legs, watermark, text, subtitles'
$Models = Join-Path $Root 'models'
$Out = Join-Path $Root 'out'
New-Item -ItemType Directory -Force $Models, $Out, "$Models\diffusion_models", "$Models\text_encoders", "$Models\vae" | Out-Null

$HfWan21 = 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files'
$Fetch = @(
  @{ to = "$Root\dl\sd-cuda.zip"; url = 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/sd-master-3f8527a-bin-win-cuda12-x64.zip' },   # 0.34 GB
  @{ to = "$Root\dl\sd-cudart.zip"; url = 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/cudart-sd-bin-win-cu12-x64.zip' },          # 0.56 GB
  @{ to = "$Models\diffusion_models\wan2.1_t2v_1.3B_fp16.safetensors"; url = "$HfWan21/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors" },                         # 2.84 GB
  @{ to = "$Models\vae\wan_2.1_vae.safetensors"; url = "$HfWan21/vae/wan_2.1_vae.safetensors" },                                                                     # 0.25 GB
  @{ to = "$Models\text_encoders\umt5-xxl-encoder-Q8_0.gguf"; url = 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q8_0.gguf' },  # 6.04 GB (sd.cpp)
  @{ to = "$Models\text_encoders\umt5_xxl_fp8_e4m3fn_scaled.safetensors"; url = "$HfWan21/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" },                   # 6.74 GB (ComfyUI)
  @{ to = "$Root\dl\comfyui-cu126.7z"; url = 'https://github.com/comfyanonymous/ComfyUI/releases/download/v0.46.0/ComfyUI_windows_portable_nvidia_cu126.7z' }          # 1.98 GB
)

function Get-VramUsed { [int](& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1) }

function Start-VramWatch {
  Start-Job -ScriptBlock {
    $peak = 0
    while ($true) {
      $v = [int](& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1)
      if ($v -gt $peak) { $peak = $v; Set-Content -Path $using:Out\vram-peak.txt -Value $peak }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Write-Row($engine, $run, $seconds, $base, $file, $note) {
  $peak = if (Test-Path "$Out\vram-peak.txt") { [int](Get-Content "$Out\vram-peak.txt") } else { 0 }
  $bytes = if ($file -and (Test-Path $file)) { (Get-Item $file).Length } else { 0 }
  $csv = Join-Path $Root 'results.csv'
  if (-not (Test-Path $csv)) { 'engine,run,seconds,vram_base_mb,vram_peak_mb,file,bytes,note' | Set-Content $csv }
  "$engine,$run,$seconds,$base,$peak,$(Split-Path -Leaf "$file"),$bytes,$note" | Add-Content $csv
  Write-Host "$engine run $run : $seconds s, card memory peak $peak MB (base $base), $bytes bytes, $note"
}

if ($Step -eq 'fetch') {
  New-Item -ItemType Directory -Force "$Root\dl" | Out-Null
  foreach ($f in $Fetch) {
    if (Test-Path $f.to) { Write-Host "have $($f.to)"; continue }
    Write-Host "fetching $($f.url)"
    & curl.exe -L --fail -C - -o "$($f.to).part" $f.url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $($f.url)" }
    Move-Item "$($f.to).part" $f.to
  }
  Expand-Archive -Force "$Root\dl\sd-cuda.zip" "$Root\sd"
  Expand-Archive -Force "$Root\dl\sd-cudart.zip" "$Root\sd"
  Write-Host "Unpack $Root\dl\comfyui-cu126.7z into $Root with 7-Zip (Windows tar may not read it); trying tar first."
  & tar.exe -xf "$Root\dl\comfyui-cu126.7z" -C $Root
  if ($LASTEXITCODE -ne 0) { Write-Host 'tar could not unpack it: use 7-Zip, Extract to here, inside the folder above.' }
  exit 0
}

& nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv | Set-Content "$Out\card.txt"
Get-Content "$Out\card.txt"

if ($Step -eq 'sd') {
  $cli = Get-ChildItem -Recurse -Filter sd-cli.exe "$Root\sd" | Select-Object -First 1
  if (-not $cli) { throw "sd-cli.exe not found under $Root\sd: run -Step fetch first" }
  for ($r = 1; $r -le $Runs; $r++) {
    foreach ($extra in @(@('--diffusion-fa'), @('--diffusion-fa', '--offload-to-cpu', '--vae-tiling'))) {
      $tag = if ($extra.Count -gt 1) { 'offload' } else { 'card' }
      $clip = "$Out\sd-run$r-$tag.webm"
      $log = "$Out\sd-run$r-$tag.log"
      Remove-Item -ErrorAction SilentlyContinue "$Out\vram-peak.txt", $clip
      $base = Get-VramUsed
      $watch = Start-VramWatch
      $cliArgs = @('-M', 'vid_gen', '--diffusion-model', "$Models\diffusion_models\wan2.1_t2v_1.3B_fp16.safetensors",
        '--vae', "$Models\vae\wan_2.1_vae.safetensors", '--t5xxl', "$Models\text_encoders\umt5-xxl-encoder-Q8_0.gguf",
        '-p', $Prompt, '-n', $Negative, '--cfg-scale', '6.0', '--sampling-method', 'euler', '--steps', "$Steps",
        '-W', "$Width", '-H', "$Height", '--video-frames', "$Frames", '--fps', '16', '--flow-shift', '3.0',
        '--seed', "$Seed", '-o', $clip, '-v') + $extra
      $t = [Diagnostics.Stopwatch]::StartNew()
      $p = Start-Process -FilePath $cli.FullName -ArgumentList ($cliArgs | ForEach-Object { '"' + $_ + '"' }) -NoNewWindow -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
      $p.WaitForExit()
      $secs = [math]::Round($t.Elapsed.TotalSeconds, 1)
      Stop-Job $watch; Remove-Job $watch
      $ok = Test-Path $clip
      Write-Row 'sd.cpp' $r $secs $base $clip $(if ($ok) { $tag } else { "$tag failed exit $($p.ExitCode), see log" })
      if ($ok) { break }   # the offload try runs only when the all-on-card try failed
    }
  }
}

if ($Step -eq 'comfy') {
  $portable = Get-ChildItem -Directory $Root -Filter 'ComfyUI_windows_portable*' | Select-Object -First 1
  if (-not $portable) { throw "ComfyUI_windows_portable not found under ${Root}: unpack it first" }
  $comfy = Join-Path $portable.FullName 'ComfyUI'
  @"
video_test:
  base_path: $Models
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
"@ | Set-Content -Encoding ascii (Join-Path $comfy 'extra_model_paths.yaml')
  $base = Get-VramUsed
  $proc = Start-Process -FilePath (Join-Path $portable.FullName 'python_embeded\python.exe') -NoNewWindow -PassThru `
    -ArgumentList '-s', "`"$comfy\main.py`"", '--windows-standalone-build', '--listen', '127.0.0.1', '--port', '8188', '--disable-auto-launch' `
    -RedirectStandardOutput "$Out\comfy.log" -RedirectStandardError "$Out\comfy.err.log"
  $api = 'http://127.0.0.1:8188'
  $t0 = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try { Invoke-RestMethod "$api/system_stats" | Out-Null; break } catch { Start-Sleep 1 }
    if ($proc.HasExited) { throw 'ComfyUI stopped while starting: see comfy.err.log' }
  }
  Write-Host "ComfyUI up after $([math]::Round($t0.Elapsed.TotalSeconds,1)) s (pid $($proc.Id))"
  try {
    for ($r = 1; $r -le $Runs; $r++) {
      $prefix = "video-test-run$r"
      $graph = @{
        '1' = @{ class_type = 'UNETLoader'; inputs = @{ unet_name = 'wan2.1_t2v_1.3B_fp16.safetensors'; weight_dtype = 'default' } }
        '2' = @{ class_type = 'CLIPLoader'; inputs = @{ clip_name = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'; type = 'wan'; device = 'default' } }
        '3' = @{ class_type = 'VAELoader'; inputs = @{ vae_name = 'wan_2.1_vae.safetensors' } }
        '4' = @{ class_type = 'CLIPTextEncode'; inputs = @{ text = $Prompt; clip = @('2', 0) } }
        '5' = @{ class_type = 'CLIPTextEncode'; inputs = @{ text = $Negative; clip = @('2', 0) } }
        '6' = @{ class_type = 'EmptyHunyuanLatentVideo'; inputs = @{ width = $Width; height = $Height; length = $Frames; batch_size = 1 } }
        '7' = @{ class_type = 'ModelSamplingSD3'; inputs = @{ shift = 3.0; model = @('1', 0) } }
        '8' = @{ class_type = 'KSampler'; inputs = @{ seed = $Seed; steps = $Steps; cfg = 6.0; sampler_name = 'euler'; scheduler = 'simple'; denoise = 1.0
            model = @('7', 0); positive = @('4', 0); negative = @('5', 0); latent_image = @('6', 0) } }
        '9' = @{ class_type = 'VAEDecode'; inputs = @{ samples = @('8', 0); vae = @('3', 0) } }
        '10' = @{ class_type = 'SaveWEBM'; inputs = @{ images = @('9', 0); filename_prefix = $prefix; codec = 'vp9'; fps = 16.0; crf = 32.0 } }
      }
      Remove-Item -ErrorAction SilentlyContinue "$Out\vram-peak.txt"
      $watch = Start-VramWatch
      $t = [Diagnostics.Stopwatch]::StartNew()
      $id = (Invoke-RestMethod -Method Post "$api/prompt" -ContentType 'application/json' -Body (@{ prompt = $graph } | ConvertTo-Json -Depth 10)).prompt_id
      $note = 'ok'
      while ($true) {
        Start-Sleep 2
        $h = Invoke-RestMethod "$api/history/$id"
        if ($h.$id) { if ($h.$id.status.status_str -ne 'success') { $note = "failed: $($h.$id.status.status_str)" }; break }
        if ($proc.HasExited) { $note = 'ComfyUI crashed'; break }
      }
      $secs = [math]::Round($t.Elapsed.TotalSeconds, 1)
      Stop-Job $watch; Remove-Job $watch
      $clip = Get-ChildItem "$comfy\output" -Filter "$prefix*.webm" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
      if ($clip) { Copy-Item $clip.FullName "$Out\comfy-run$r.webm" }
      Write-Row 'ComfyUI' $r $secs $base $(if ($clip) { "$Out\comfy-run$r.webm" } else { '' }) $(if ($r -eq 1) { "$note (cold: loads models)" } else { "$note (warm)" })
    }
  } finally {
    Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue   # only the ComfyUI started here, by its PID
  }
}
