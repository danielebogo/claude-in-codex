# Security boundary lessons

- Loopback, Host and Origin checks do not authenticate local processes. Authenticate HTTP and WebSocket requests before reading prompts, opening upstream connections or launching native tools; message roles are input, not caller identity.
- Bound encoded bodies, decompressed output, receive time, concurrent work and aggregate WebSocket queues. A rejected local decode must not fall through to upstream forwarding.
- A disconnect cannot release capacity while decompression is still running. Release input-processing capacity after decoding settles, while allowing completed tool handoffs and their continuations to make progress at the capacity limit.
- At full WebSocket capacity, reserve the exact waiting turn's slot before cancelling it, and transfer that slot only after the original handler settles. Same-thread replacements and compaction must progress; concurrent replacements, unrelated threads and HTTP-owned turns cannot claim the same slot.
- Verify a newly launched listener with a fresh challenge bound to its private installation identity before changing client routes. Never send the bearer capability to an unverified health endpoint.
- Debugging output needs an allowlist that excludes free text, private modes, exclusive filenames and bounded retention. Field-name redaction cannot reliably remove secrets embedded in prompts.
