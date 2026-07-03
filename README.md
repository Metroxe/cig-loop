![Cig Loop](logo.jpg)


# Cig Loop
**Cig Loop** is a ralph loop library for Claude Code. Skips the setup, gives you boilerplates, and adds quality-of-life so you can focus on your prompt.

We measure costs in cigarettes. A cigarette burns at roughly the same speed Opus tokens stream, and costs about the same per minute. So we track time in cigs and costs in packs.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Metroxe/cig-loop/main/install.sh | bash
```

## Run

```bash
cig-loop
```

Runs the loop interactively. For non-interactive / CI usage:

```bash
cig-loop -p ./PROMPT.md -i 10 -m opus --no-interactive
```

## Boilerplate

```bash
cig-loop boilerplate
```

Pulls a starter template so you don't write the same scaffolding twice. `--list` to see what's available, `--name <template>` to skip the menu.

## Update

```bash
cig-loop update
```

Self-updates the binary in place.

## ScheduleWakeup pacing

cig-loop is the re-invoker for headless `claude -p`: each iteration is a fresh
one-shot process, and the loop starts the next as soon as the last returns.

`ScheduleWakeup` is a harness tool that means "re-invoke me in N seconds." An
interactive Claude Code session honors that; under `claude -p` there is no such
harness, so **cig-loop honors it instead** — if the agent calls `ScheduleWakeup`
during an iteration, the loop waits before the next one. The effective wait is
the greater of the fixed `--delay` floor and the agent's requested `delaySeconds`
(clamped to `[1s, 1h]`): the agent can pace itself *slower* than the floor (e.g.
"poll CI again in 20 min") but never faster.

Without this, an agent that means "wait 20 minutes" gets re-invoked back-to-back
in seconds — wasted iterations, tokens, and CI load. Agents that never call
`ScheduleWakeup` are unaffected; only `--delay` applies.
