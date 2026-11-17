# Security boundary lessons

- Loopback, Host and Origin checks do not authenticate local processes. Authenticate HTTP and WebSocket requests before reading prompts, opening upstream connections or launching native tools; message roles are input, not caller identity.
- Bound encoded bodies, decompressed output, receive time, concurrent work and aggregate WebSocket queues. A rejected local decode must not fall through to upstream forwarding.
- A disconnect cannot release capacity while decompression is still running. Release input-processing capacity after decoding settles, while allowing completed tool handoffs and their continuations to make progress at the capacity limit.
- At full WebSocket capacity, reserve the exact waiting turn's slot before cancelling it, and transfer that slot only after the original handler settles. Same-thread replacements and compaction must progress; concurrent replacements, unrelated threads and HTTP-owned turns cannot claim the same slot.
- Verify a newly launched listener with a fresh challenge bound to its private installation identity before changing client routes. Never send the bearer capability to an unverified health endpoint.
- Debugging output needs an allowlist that excludes free text, private modes, exclusive filenames and bounded retention. Field-name redaction cannot reliably remove secrets embedded in prompts.
- Native providers must scope session markers, durable ownership, process locks and pending tool continuations independently. Preserve legacy Claude markers, replay history on provider switches, and reject live slug reassignment to another provider.
- CLI output compatibility does not prove input, MCP, auth, fork or compaction compatibility. Verify those protocols with the installed CLI before describing installed-service support; unsupported fork operations must never mutate a parent session.
- Grok ACP resumes through a fresh native process. Loading an already-open session in the same ACP process can stall, and deferred MCP calls can use a use_tool wrapper whose real tool identity arrives in later sparse updates.
- Verify provider telemetry through response.completed, not only the CLI adapter. Preserve observed totals and sparse/final usage even without assistant output; do not infer missing token components or reuse Claude-specific cache arithmetic for another provider.
- Decode UTF-8 incrementally across stdin pipe chunks and enforce input limits on raw bytes. Regression tests must control chunk boundaries so a multibyte character actually spans separate reads.

- A supported optional provider must not require another provider's CLI. Discover catalogs through bounded metadata-only handshakes, preserve manual and hidden historical routes, and isolate installer tests from real provider binaries and the user's home directory.
- Validate provider readiness under the background service's credential environment, not shell-only overrides. Carry discovered model capabilities through request execution: an empty effort list must suppress the native effort flag, including Codex's default none.
