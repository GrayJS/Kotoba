# Third-party components

This application uses the following independently licensed software. License texts
provided by the runtime packages are retained in the packaged resources.

- Electron — MIT; Chromium and Node.js notices are included in the Electron runtime.
  https://github.com/electron/electron/blob/main/LICENSE
- React and React DOM — MIT. https://github.com/facebook/react/blob/main/LICENSE
- Python — Python Software Foundation license. https://docs.python.org/3/license.html
- faster-whisper — MIT. https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE
- CTranslate2 — MIT. https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE
- ONNX Runtime — MIT. https://github.com/microsoft/onnxruntime/blob/main/LICENSE
- Silero VAD — MIT, distributed as part of faster-whisper's assets.
  https://github.com/snakers4/silero-vad/blob/master/LICENSE
- NumPy — BSD-3-Clause. https://github.com/numpy/numpy/blob/main/LICENSE.txt
- python-soxr — LGPL-2.1-or-later; libsoxr — LGPL-2.1-or-later.
  https://github.com/dofuuz/python-soxr
- PyAV — BSD-3-Clause; its FFmpeg shared libraries have their own licenses.
  Source and build information for the pinned wheels: https://github.com/PyAV-Org/PyAV/tree/v16.1.0
  FFmpeg source and license: https://ffmpeg.org/legal.html
- Hugging Face Hub and Tokenizers — Apache-2.0.
  https://github.com/huggingface/huggingface_hub
  https://github.com/huggingface/tokenizers
- PyInstaller — GPL-2.0-or-later with the bootloader distribution exception.
  https://pyinstaller.org/en/stable/license.html
- NVIDIA cuBLAS 12.9.1.4 and cuDNN 9.10.2.21 — NVIDIA redistribution terms;
  the original license files are included under `resources/gpu/`.
  https://docs.nvidia.com/cuda/eula/
  https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html

Model weights are not included in the installer. Ollama is an external dependency.
The default Index-Translate-2B model uses Apache-2.0; the default Whisper large-v3-turbo
model and its CTranslate2 conversion use MIT. Consult their original model cards:

- https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF
- https://huggingface.co/openai/whisper-large-v3-turbo
- https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo

The capture implementation uses documented Windows APIs. Microsoft's process-loopback
sample was consulted as API reference: https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback

Development test audio is obtained separately from JSUT and is never bundled in the
application. Original JSUT license and attribution accompany the downloaded test clips:
https://sites.google.com/site/shinnosuketakamichi/publication/jsut
