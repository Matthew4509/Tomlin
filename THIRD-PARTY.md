# Third-party parts

TOMLIN's own files are under the PolyForm Noncommercial licence 1.0.0 (LICENSE). These parts are other people's and keep their own licences.

## Shipped in the zip

| Part | Version | Licence | Where |
|---|---|---|---|
| Node.js (node.exe, Windows x64), runs TOMLIN and its installer | 24.16.0 | MIT; it contains parts under their own licences (V8, OpenSSL, ICU, libuv, and others), listed in full in runtime/node/LICENSE (the LICENSE file of that Node.js release, https://github.com/nodejs/node/blob/v24.16.0/LICENSE) | runtime/node |
| llama.cpp (llama-server, CPU build) | b11284 | MIT | runtime/llama-cpu |
| stable-diffusion.cpp (sd-server, CPU build) | master-929 (3f8527a) | MIT | runtime/sd-cpu |
| LLVM OpenMP runtime (inside the llama.cpp build) | | Apache-2.0 with LLVM exception | runtime/llama-cpu/LICENSE-LLVM-OpenMP |
| sharp | 0.35.5 | Apache-2.0 | node_modules/sharp |
| libvips and the libraries inside @img/sharp-win32-x64 | 8.18.7 | LGPL-3.0-or-later (libvips; loaded as a separate DLL, not changed), others as listed in its versions.json | node_modules/@img/sharp-win32-x64 |
| ONNX Runtime (onnxruntime-node, Windows x64 only) | 1.30.0 | MIT | node_modules/onnxruntime-node |
| U2-Net small (u2netp.onnx), background remover | rembg release v0.0.0 | Apache-2.0 | models/helpers/u2netp.onnx |
| PDF.js (pdfjs-dist), reads the text of a PDF dropped into a chat; only its Node text reader, font tables and character maps are shipped | 6.4.299 | Apache-2.0 | node_modules/pdfjs-dist |

## Downloaded when you choose them (not in the zip)

| Part | Licence | Notes |
|---|---|---|
| llama.cpp and stable-diffusion.cpp Vulkan and CUDA builds | MIT; the CUDA runtime DLLs are under NVIDIA's licence | `npm run fetch -- <id>`, ids in runtimes.json |
| Realistic Vision 6 (SD 1.5) | CreativeML OpenRAIL-M | Use limits apply (no illegal or harmful uses); commercial use allowed |
| LCM LoRA for SD 1.5 | OpenRAIL++ | |
| TAESD | MIT | |
| DreamShaper 8 LCM | CreativeML OpenRAIL-M | |
| Qwen-Image 2.1 | Qwen RESEARCH LICENSE: **non-commercial only** | Not for a business website or blog without a commercial licence from Qwen. If you share copies, the licence asks for its notice file |
| Qwen3-VL 8B (Qwen-Image's text encoder) | Apache-2.0 | |
| Chat models | Each model's own | Shown when you add them; TOMLIN does not ship any |
