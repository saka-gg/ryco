# Environment-local voice input

Voice records up to 60 seconds on the client, sends bounded PCM audio to the
composer's chosen machine, and runs inference there. Review and edit the result,
then choose **Insert into draft**. Sending the draft is a separate action.
There is no cloud transcription service, subscription, or automatic model download.
For a remote machine, audio leaves the recording device and is processed on that
machine. The ordinary authorized connection and hosted encrypted relay carry it.

## Setup and availability

The server has an optional, lazily loaded `transcribe-cpp` 0.2.1 helper. Installs
that omit optional dependencies cannot transcribe. Native artifacts are available
for macOS arm64/x64, Linux arm64/x64, and Windows x64; other platforms report
unavailable. Native binary compatibility still depends on the target OS and ABI.
The helper runs in an isolated child process, on CPU with two inference threads.
It does not load native inference code into the server process.

The default model is multilingual Whisper Tiny Q8_0. The first recording attempt
with no installed model offers an explicit download action:

- File: `whisper-tiny-Q8_0.gguf`
- Size: **45,981,088 bytes**
- Revision: `6687f30c99641ee265df421e582354adbc8848fc`
- SHA-256: `325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834`
- [Pinned model source](https://huggingface.co/handy-computer/whisper-tiny-gguf/tree/6687f30c99641ee265df421e582354adbc8848fc)
- Conversion metadata: Apache-2.0; original [Whisper code and weights](https://github.com/openai/whisper#license): MIT.

Installation is on the chosen server, under its state directory's `speech/`
folder. It validates exact size and checksum before installation. Cancelled or
failed downloads leave no installed partial model. Startup removes interrupted
partial downloads. Recording and inference never initiate a model download.
An installed model works without contacting its distribution host.

Microphone access requires a browser secure context or a desktop app with microphone
permission. Native iOS requires a build containing `RycoVoice`; older development
clients and Android currently show capture unavailable. The frozen web phone
presentation does not gain voice controls.

## Resource and failure behavior

One voice job runs per server environment. Uploads are acknowledged in order,
with at most 32 KiB of PCM per request and 1,920,000 bytes per recording. Inference
has a 120-second deadline; abandoned jobs expire within 150 seconds. Native compute
must exit before the job slot becomes available again.

Jobs belong to one authenticated socket, not the auth session shared by browser
tabs. Only existing owner authority permits these RPCs. Backgrounding, navigation,
cancellation, disconnect, and stale authorization discard the local operation.
When authority is still valid, the client also requests cancellation of its server
job. The server cleans up on socket close and expires abandoned uploads. Reconnect
never resumes a recording or automatically retries inference.

Audio is transient. Browser and iOS capture buffers stay in memory and are released
on every exit; raw audio is never adopted as a message attachment, persisted as a
draft, logged as content, or placed in service-worker caches. Explicitly inserted
text becomes an ordinary draft and follows existing draft persistence policy.

## Implementation and provenance

Shared controller: `packages/client-runtime/src/voice`. Contracts contain schemas
only. Platform adapters own microphone APIs; server speech services own model and
process lifetime. Existing lifecycle, authorization, and relay owners remain intact.

[Upstream T3 Code PR #8928](https://github.com/pingdotgg/t3code/pull/8928) was reviewed
at `61e67fc019da2e4377dc0249caa583d4cc71b7ff`, still open on 2026-09-15. Ryco implements
the bounded behavior independently; it does not copy the upstream voice subsystem.
The optional [transcribe.cpp helper](https://github.com/handy-computer/transcribe.cpp)
is MIT-licensed. Its packaged native libraries include their `licenses/` directory;
distribution must retain those notices. No model is bundled in the app or CLI.
