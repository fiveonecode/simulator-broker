# Client

CLI client and compatibility wrappers live here.

Current entrypoint:

- `node client/bin/simbroker.mjs`

Current command families:

- `doctor`
- `host init`
- `host status`
- `capacity check`
- `capacity reconcile`
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
