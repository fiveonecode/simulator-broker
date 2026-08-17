# Concepts

Related: [README](../README.md), [Getting started](getting-started.md), [Harness integration](../spec/harness-integration.md)

Simulator Broker is a machine-local control plane. One Mac has one broker.
Many repos ask that broker for a simulator *purpose*. The broker picks an
*alias* and hands out a *lease*.

```text
  humans / agents / CI
            |
            v
     simbroker CLI  ----+
                        |   Unix socket
     Simulator Broker.app --+-->  brokerd
                                 |
                                 v
                    host aliases (ui-1, manual-1, ...)
                                 |
                                 v
                          iOS Simulator
```

## Host

The host is this Mac. Host config records the broker-managed simulator aliases,
their device family, and the real Simulator IDs. First-run setup writes that
config. Do not edit those files by hand.

## Project

A consumer repo commits `.simulator-broker/project.json`. That file names the
repo and the purposes it can request. It must not contain machine-local alias
names or Simulator UDIDs.

## Purpose

A purpose is a kind of work: `manual-testing`, `agent-ui-session`,
`agent-build-test`, `ci-ui-test`. The repo asks for a purpose. The broker maps
that purpose onto a compatible alias.

## Alias

An alias is a broker-managed slot such as `ui-1` or `manual-1`. Aliases have a
reset policy (for example erase-on-acquire for UI slots) and a capability class.
Humans and agents should not call `simctl` directly against broker-managed
aliases.

## Lease

A lease is a time-bounded claim on an alias. Acquire before simulator work,
release in a `trap` or `finally`. The broker boots the chosen device on
acquire when needed. Stale leases from dead processes can be recovered.

## Pin

A pin is a durable reservation, usually for a human manual slot. Pins survive
broker restart until they are cleared. Automation should not take a pinned
manual alias.

## brokerd

`brokerd` is the local service. The CLI talks to it when it is running so the
app, scripts, and interactive shells share one authority. The macOS app does
not mutate simulator state behind the broker's back.

## Capacity and idle

`capacity check` reports whether a repo purpose can be served.
`capacity reconcile` previews missing aliases and applies only after a human
confirms the exact plan ID.

Automatic shutdown is off until a human sets a duration in the app or CLI.
Idle cleanup is also confirm-only.

## What stays machine-local

Host config, live leases, pins, event logs, and `app-snapshot.json` stay under
the broker state root on this Mac. Consumer repos commit only project policy
and wrappers.
