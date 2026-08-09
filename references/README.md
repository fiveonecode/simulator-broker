# Reference Material

This repo no longer checks in copied product snapshots as implementation
context. Public examples live under `examples/harness-adoption/`, and the
active broker contract lives under `spec/`.

## Public Example Surface

- `examples/harness-adoption/sample-consumer-repo/` demonstrates consumer repo
  policy, wrapper scripts, agent instructions, and CI wiring.
- `spec/harness-integration.md` is the canonical contract for adopting
  Simulator Broker in a real repo.

## Private Context Rule

Do not add product-specific source snapshots, local machine paths, credentials,
private task records, or private company notes under this directory. If a future
implementation needs source-derived context, extract the generic behavior into
`spec/` or into a minimal public fixture under `examples/`.
