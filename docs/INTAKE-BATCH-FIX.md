# Complete intake batches (2026-09-16)

The collector counted five voice messages but `_dispatch` copied only the last
Telegram envelope. Earlier media became tags, then the handler stripped those
tags and transcribed only the final voice. A text last item lost every attachment.
Caption-first handling could also discard accompanying accumulated text.

The DO now carries every original envelope. The message handler resolves every
voice/audio/video and file before issuing one deep task, in Telegram message order.
Text and captions stay beside their source message. A failed preparation restores
the batch and presents the existing launch button; it never submits partial input.
Short state mutations are serialized so concurrent append/launch cannot overwrite
messages or dispatch a batch twice. In-progress input is persisted for alarm recovery.

Multiple files use a standard TAR through the existing single-file agent contract;
no new package, agent-server restart, or extra agent sessions are required. The
agent must extract the archive to inspect those files. Each voice incurs the usual
STT charge; a retry currently transcribes the entire batch again. Telegram's existing
20 MB per-file limit and the agent's existing HTTP body limit remain in force.
Alarm recovery offers a manual retry, never automatic replay: if a worker dies after
an ambiguous HTTP acceptance, this does not provide end-to-end exactly-once execution.

Regression tests exercise the real DO and real message handler to captured runTask:
five voices; voice + captioned photo + final text; failed preparation; multiple files
validated by system tar; overlapping appends + duplicate launch; isolate recovery.
The original one-message tests remain. Collector bubble design is unchanged.
