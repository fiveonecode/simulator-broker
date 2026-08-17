# Client

CLI client and compatibility wrappers live here.

Help and `doctor` print human-readable text by default. Pass `--json` for
machine-readable payloads. Other commands still emit JSON by default so
existing wrappers keep working.

Current entrypoint:

- `node client/bin/simbroker.mjs`

Current command families:

- `doctor`
- `host init`
- `host status`
- `capacity check`
- `capacity reconcile`
- `idle status`
- `idle enable`
- `idle disable`
- `idle reconcile`
- `idle cleanup`
- `project init`
- `project validate`
- `project show`
- `lease acquire`
- `lease register-process`
- `lease contain`
- `lease explain`
- `lease show`
- `lease release`
- `events watch`
- `pin create`
- `pin clear`
- `simulators boot`
- `simulators shutdown`
- `simulators erase`
- `simulators repair`

Onboarding helpers now included:

- `host init --bootstrap-config` writes a starter host config when no machine-local config exists yet
- `project init` scaffolds `.simulator-broker/project.json` for a fresh consumer repo
- `capacity check` reports whether repo purposes have usable broker capacity
- `capacity reconcile` previews missing additive capacity and applies only when
  a human operator confirms the exact current plan ID
- `idle enable` requires a human operator and an explicit duration from 60
  through 86400 seconds; no duration is configured by default
- `idle cleanup` returns a count-only preview and applies only when a human
  confirms the exact current plan ID

Normal policy-enabled lease acquisition starts `brokerd` lazily when needed so
scheduled reconciliation remains active. Explicit local-only mode does not
schedule reconciliation and reports that limitation.
