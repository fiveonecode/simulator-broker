# Broker Core

File-backed broker-core implementation lives here.

Current scope:

- host config validation
- repo project config validation
- registry, lease, pin, and event storage
- deterministic alias selection
- stale lease recovery
- capacity check and additive reconcile planning
- transaction journaling, rollback, and recovery for confirmed capacity apply
- event history reads for CLI inspection
- broker-facing JSON payloads used by the CLI
