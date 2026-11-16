# 0099 — A script in an automation runs apart from the instance, as its author

- Status: Accepted
- Date: 2026-11-16

## Context

An automation's actions are fixed gestures with the row's values put in
their texts (ADR 0008, ADR 0022). What they cannot say is a
calculation, a decision over several rows, a value reshaped before it
is written. People ask for a script there: a few lines of their own
between two actions.

A script is code a member wrote, run by the instance. Whatever runs it
must hold when the script is hostile or simply wrong: it must not read
what its author may not, reach the instance's keys or its database,
call the network from inside the operator's, or take the process's
memory and time with it.

## Decision

- **A script is an action**, `run_script`, at the top of an automation,
  in a branch, or in a loop. It is JavaScript, 20,000 characters at
  most. It reads `input` (the trigger, the table, the row as the public
  API gives a record, and the values texts use), and what it returns is
  given to the actions after it as `{{script_<key>}}`. What it writes
  with `console.log` is kept with the run.
- **Three walls, each enough against a plain mistake, together against
  a hostile script.**
  1. The script runs in a QuickJS interpreter compiled to WebAssembly.
     It sees the language and three names, nothing of Node: no `process`,
     no `require`, no `fetch`, no timer. The interpreter has a memory
     ceiling (32 MiB), a stack ceiling, and is interrupted once its time
     is up: 10 seconds, the instance's answers included, and a minute
     for all the scripts of one run.
  2. The interpreter lives in a process of its own, started with Node's
     permission model: it may read its own code and nothing else on the
     disk, write nowhere, open no connection, start no process and no
     thread. It is given an empty environment, so neither the database's
     address nor a key is there to be found, and a heap of its own
     (128 MiB). The API process ends it at the time limit, whatever it
     is doing. One process serves the scripts of one run, each in an
     interpreter of its own, and ends with the run.
  3. What a script does to the instance it asks, as text, of the API
     process, which checks every value and does it with the public API's
     own operations (`apps/api/src/public-api`), **as the automation's
     author**: their roles as they are now, their field and row rules,
     on the tables of the automation's base and no other. A write is on
     the trail under the automation's name, as its other writes are, and
     counts toward the same depth limit.
- **What a script may ask** is reading and writing records:
  `records.list`, `get`, `create`, `update`, `delete`, with the public
  API's shapes. One hundred calls a script at most, one at a time, each
  bounded in what it carries and what it is answered.
- **Off until an administrator allows it.** `automationScripts`, in
  Administration under Security, is off on a new instance and on one
  that upgrades: an operator's instance runs members' code only once
  they said so. Off, an automation with a script is not saved, and one
  saved before fails at its script. The setting asks for the proof (ADR 0073) and is not among those an administration token may change (ADR
  0086).
- **A few at once.** Four scripts run at a time in one API process; the
  others wait their turn.

## Consequences

- Two packages join the API: `quickjs-emscripten-core` and
  `@jitl/quickjs-ng-wasmfile-release-sync` (both MIT), with no native
  part to build.
- The process is started from the bundle's `script-runner.js`; from the
  sources, Node runs `runner.ts` by erasing its types, which is why that
  file imports nothing of the product and uses no syntax that needs
  compiling.
- A script's source is part of its automation: it is on the change
  trail with it, and an earlier version is put back as the rest is
  (ADR 0089).
- Each script in flight costs the instance a process: at most four at
  once, each within 128 MiB of heap beside the interpreter's 32 MiB.
- The second wall is there for what gets past the first, not instead
  of it: a process may still signal another of the same account, and
  memory outside its heap is not counted. Only the interpreter keeps a
  script from the process it runs in.
- `anygriddb scripts check` runs one script as an automation does, and
  the image's smoke test calls it: where the instance is installed must
  let that process start.

## Rejected

- **Node's `vm` module**, alone or in a child process. It separates
  globals, not privileges: code inside reaches the host's objects, and
  from a child process could still signal its parent or take the
  machine's memory.
- **A native isolate library.** It runs in the API's own address space
  unless given a process as well, and brings a compiled part to every
  architecture the image is built for.
- **A second runtime or a sidecar container** for scripts: a second
  thing to install, update, and secure, for an install that is one
  image.
- **Calls to the network from a script.** A script that fetches would
  need what webhooks have (public addresses only, pinned, bounded) and a
  place to keep a secret that the trail does not record. Until then an
  automation calls out with its own actions, with values a script
  computed.
- **On by default.** A new way to run code should not appear on an
  operator's instance with an upgrade.
