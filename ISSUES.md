# Issues and improvements

This is the work backlog for Super-agent 2.0, a fork of [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). Each item stands alone, so a coding agent can pick one up without any other context.

## How to use this file

1. Read "Already done" and "What is not proven" below.
2. Pick an item whose dependencies are done, and start from its acceptance criteria.
3. Work on your own branch and change only what the item needs.
4. When you finish, set the item's status line to `Done (<branch or commit>)`.

**Line references** point to the unmodified upstream commit `6337fc8`, because this branch is changing. Read them with `git show 6337fc8:<path>`, then find the code in your working tree.

**Status values:**
- `Confirmed-by-test`: a test on the unmodified code shows it.
- `Confirmed-by-reading`: the code or docs show it, but nothing has executed it.
- `Needs-verification`: it looks real, but depends on behavior nobody has checked. Check that first.

**Sizes:** S is under a day, M is one to three days, L is more than three days.

**Repo rules:**
- `pnpm check` runs the typecheck, tests and build.
- `tests/docs.spec.ts:63` fails unless every test file is listed in the test table of `docs/007-architecture.md`, so add a row for each new test file.
- Never add an AI co-author or generated-by line to commit messages.
- Don't commit credentials or working injection payloads. Tests should use harmless marker text and fake canary values.

**Terms:** the docs use several words for the same things.
- Router = main Session = orchestrator.
- Worker = Executor Session.
- Ticket = one accepted piece of work.
- Trigger = one incoming event.
- Mandate = the record of why a Ticket is authorized.

## Already done

These are finished and on `main`, with typecheck, tests and build passing, but not yet run against the real harness. Don't redo them. One deliberate behavior change: comments from unlisted people, including human reviewers, no longer reach workers, so teams must add reviewers to the allowed list. `GET state` stays open without a token for the service script's health check, so `scripts/dsh-superagent` did not change.

| ID | Change | Main files |
|---|---|---|
| WIP-1 | Router loses `bash`, file reads and job tools | `src/app/sessions.ts`, `cordis.patch.yml`, `tests/bundle-patch.spec.ts` |
| WIP-2 | Router loses `orchestrator_settings_save`, `orchestrator_policy_sync` and `orchestrator_prompts_save` | `src/app/tools/main.ts`, `src/app/resources.ts`, `docs/004-prompts.md`, `docs/007-architecture.md` |
| WIP-3 | `Policy.steers` stops unauthorized people reaching or resuming workers, and attach refuses them. Unlisted follow-ups go to the admission table instead of being inferred | `src/policy.ts`, `src/core/intake.ts`, `src/core/tickets.ts`, `src/core/ports.ts`, `docs/002-authorization.md` |
| WIP-4 | `sender` label (`authorized` or `automated`) on messages to workers, plus prompt rules about untrusted text | `src/executor/dsh.ts`, `prompts/work.md`, `prompts/orchestrator.md`, `prompts/admission.md` |
| WIP-5 | Token auth on the panel API | `src/app/panel-token.ts`, `src/app/http.ts`, `src/client/api.ts`, `tests/fixtures/host.ts` |
| WIP-6 | `tests/attack-chain.spec.ts` flipped to assert the safe behavior | `tests/attack-chain.spec.ts` |

## What is not proven

- **The attack is untested with a real model and harness.** The tests in `tests/attack-chain.spec.ts` use a fake harness and no LLM. They show what the host permits, not that a model would follow an injected comment. See SEC-04.
- **A panel token is not a security boundary until workers are isolated.** Workers run as the operator's OS user, so they can read the token file and read or write `orchestrator.sqlite` in the state directory directly. WIP-5 helps only once SEC-01 is done.
- **The WIP changes haven't run under the real harness.** Removing the router's tools may affect skill loading or other harness behavior. See TEST-01.

---

# P0: must be fixed before calling this secure

## SEC-01: Workers run unconfined as the operator's OS user
- **Evidence:** `src/app/sessions.ts:152`, `docs/003-execution.md:27`, `docs/003-execution.md:80`, `src/infra/environment.ts:4`. The harness's `docs/subsystems/sandbox.md` says `danger-full-access` bypasses confinement.
- **Failure:** a worker that is misled, or runs malicious repo code, can read and change anything the operator can, including `~/.ssh`, other projects, and the state directory. It can also execute a blocked command by absolute path.
- **Fix:** run each Ticket in a container or microVM with only its checkout mounted, a non-operator user, and no host home directory. Docker is available on the development machine. First find out whether the harness shell tool can target a container, or whether commands must go through a broker.
- **Acceptance:** an integration test runs a worker command that tries to read a canary file in the host home and write to the state directory, and both fail. The blocked-command list is no longer the only control.
- **Size:** L. **Depends on:** none. **Status:** Done on the standalone host for macOS (Seatbelt) and Linux (bubblewrap, profile tested, not run): `src/sandbox/`, `tests/sandbox.spec.ts`. The canary tests pass: a confined process cannot read a canary in the home directory, read or write the state directory, or write outside its workspace, and the real Claude Code CLI runs confined. Not done: a container or microVM, Windows, the DeepSeek Harness path, and credentials in reach (SEC-02): the CLI's own sign-in stays readable, and the network is open.

## SEC-02: Long-lived credentials are within a worker's reach
- **Evidence:** `docs/006-deployment.md:33` requires a GitHub user account and rules out a GitHub App. `src/infra/environment.ts:100` and following write `gh` and `lark-cli` shims. `src/deployment.ts:104` checks only that the account can push.
- **Failure:** the agent account's login sits in a config directory that workers can read, and it isn't limited to one repo or branch. A compromised worker can use it directly and elsewhere. `Commands.path` limits the host's calls (`src/infra/commands.ts:94`), not a worker's own `gh` calls.
- **Fix:** use a GitHub App with short-lived installation tokens scoped to one repo. Add a broker or proxy outside the sandbox that adds credentials to requests, so the model and the worker's filesystem never hold them. Replace the notifications polling that forces a user account (see CAP-03).
- **Acceptance:** inside a worker, no credential is readable from the environment or files, a canary scan of its transcript finds nothing, and pushes are refused outside the ticket's branch.
- **Size:** L. **Depends on:** SEC-01. **Status:** Confirmed-by-reading.

## SEC-03: Untrusted pull request code and instructions run with full access
- **Evidence:** `src/sources/github-pull.ts:39` lets a Ticket adopt its source PR whoever wrote it. `prompts/work.md:39` says to run relevant checks. `prompts/work.md:21`, `prompts/worker.md:8` and `docs/004-prompts.md:61` tell workers to read and follow repository `AGENTS.md`.
- **Failure:** a listed person asks the agent to fix a stranger's fork PR. The worker checks it out, runs its tests or install scripts with SEC-01's access, and treats its `AGENTS.md` as instructions. `Policy.steers` doesn't help, because the request came from an authorized person.
- **Fix:** mark tickets whose code comes from outside. Run their code in a sandbox with no credentials or network. Load `AGENTS.md` from the default branch, never from the PR head. Check whether `DSH_SUPERAGENT_GITHUB_PR_HEAD` (attacker-chosen on fork PRs) is safe in prepare commands, and document quoting.
- **Acceptance:** a test with a fork PR that changes `AGENTS.md` and adds a test script shows that the changed instructions aren't loaded and that the script can't reach a canary credential.
- **Size:** L. **Depends on:** SEC-01, SEC-02. **Status:** Needs-verification (prompts confirmed by reading; which `AGENTS.md` the harness loads hasn't been checked).

## SEC-04: Prove or disprove the attack end to end
- **Evidence:** `tests/attack-chain.spec.ts` uses `tests/fixtures/host.ts`, which fakes the harness and has no model.
- **Failure:** launch claims and security priorities rest on an unmeasured link: whether a model acts on injected text in a comment, and whether the unpatched host then lets it take effect.
- **Fix:** build a repeatable red-team run in a disposable container, using a throwaway GitHub account, a private test repo, a spend-limited API key and canary secrets. Run unpatched and patched builds across a set of injection cases and report the result per model. Publish rates and method, not payloads.
- **Acceptance:** one command produces a table of attack case, build, model and outcome, including failed attacks. Any canary leak in the patched build fails the run.
- **Size:** M. **Depends on:** the operator providing the account, repo and key. **Status:** Needs-verification.

## SEC-05: Workers can rewrite the control plane through the filesystem
- **Evidence:** `docs/006-deployment.md:95` puts the database, shims, git config and default Ticket directories under one `stateDir`. `src/app/store.ts:63` sets the database to `0600`, which doesn't stop the same user. `src/infra/environment.ts:66` and `:89` write shims and git config there.
- **Failure:** with WIP-5 in place, a worker can still edit Policy in SQLite, replace a shim, or read the panel token. Tickets default to living inside the same directory tree.
- **Fix:** run the host and workers under separate users or filesystems. Move Ticket directories out of `stateDir`, and keep the database, token and shims unreachable from workers.
- **Acceptance:** a test from inside a worker can't read or change the database, the token, or the shim directory.
- **Size:** M. **Depends on:** SEC-01. **Status:** Confirmed-by-reading.

---

# P1: needed for a credible release

## SEC-06: Workers still read untrusted text with no host-level marking
- **Evidence:** `docs/002-authorization.md:20` delivers bot and CI messages to tickets. `prompts/work.md:22` sends workers to the CLI for more context. `src/sources/github-read.ts:127-140` returns issue and comment text. `src/executor/dsh.ts:124` includes a preview of the replied-to message.
- **Failure:** after WIP-3, a stranger's comment is no longer delivered, but a worker still reads it when it opens the thread. It also still gets the replied-to preview, CI text, and text from unlisted bots. Only prompts tell it to treat these as data.
- **Fix:** add author trust to everything `orchestrator_read` returns, and strip or quarantine untrusted bodies by default. Limit delivered bots to the Source's bot list. Track when a session has read untrusted text, and require human approval for risky actions afterwards.
- **Acceptance:** tests show every message from a read tool carries a trust field, and a tainted session is refused a gated action until a person approves.
- **Size:** L. **Depends on:** WIP-3, WIP-4. **Status:** Confirmed-by-reading.

## SEC-07: No secret scanning or limits on outgoing data
- **Evidence:** `src/app/outbox.ts:27-33` validates only Feishu reply length. `src/app/tools/main.ts:231` accepts replies up to 20,000 characters. `prompts/orchestrator.md:15` forbids exposing private Feishu content on GitHub only by prompt. The worker preset includes `web_search` (`cordis.patch.yml`, `tool-web`), and workers can post directly with `gh` and `lark-cli`.
- **Failure:** a leaked token or private chat text can go out in a comment, a commit, a search query, or a reply. Nothing outside the model stops it.
- **Fix:** scan the outbox and pushes for secrets at the broker. Enforce an egress allowlist. Add host checks that stop Feishu-sourced text being sent to GitHub.
- **Acceptance:** tests send a fake canary through a reply, a commit and a direct CLI call, and all three are blocked and logged.
- **Size:** M. **Depends on:** SEC-02 for pushes and direct calls; the outbox scan can start alone. **Status:** Confirmed-by-reading.

## SEC-08: Removing someone's access doesn't stop their work
- **Evidence:** `docs/002-authorization.md:117` says a Policy change doesn't revoke live Mandates. `src/policy.ts:221` keeps every explicit follow-up Mandate valid with no check that the sender is still allowed, as `docs/002-authorization.md:135` documents.
- **Failure:** the operator removes a compromised account from the allowlist. Its running Ticket keeps going under a prompt that asks it to wind down, and a follow-up Mandate can still resume later.
- **Fix:** revalidate on every Policy change. Stop or pause tickets whose requester lost access. Check the sender in the follow-up branch of `revalidate`.
- **Acceptance:** a policy test removes the requester and shows that a live ticket stops and an ended one can't resume.
- **Size:** S. **Depends on:** coordinate with WIP-3, which edits this file. **Status:** Confirmed-by-reading.

## SEC-09: Merge and branch safety rely on prompts and operator setup
- **Evidence:** `docs/003-execution.md:84` says the host has no merge logic. `docs/003-execution.md:90` leaves enforcement to branch protection. `prompts/team/delivery.md:10-13` hold the rules. `src/deployment.ts:104` doesn't check protection.
- **Failure:** on a repo without branch protection, a misled worker with push access can push to the default branch or merge. Setup won't warn.
- **Fix:** check protection during setup and show a blocking warning. Have the broker refuse pushes outside `agent/*` and refuse merges.
- **Acceptance:** setup reports a problem on an unprotected test repo, and a broker test refuses a push to the default branch.
- **Size:** M. **Depends on:** SEC-02 for the broker part. **Status:** Confirmed-by-reading.

## SEC-10: Deeply nested subagents may escape tool limits
- **Evidence:** `src/app/sessions.ts:306` stops walking up after 8 levels, and `src/app/sessions.ts:310` then returns without applying limits. It also stops if a parent isn't loaded.
- **Failure:** a subagent more than 8 levels below a worker, or one whose parent isn't loaded, would keep its preset's full tools. It would also lack the guard that removes tools once the ticket ends.
- **Fix:** fail closed: give any subagent whose ancestry can't be resolved no tools, and cap nesting depth.
- **Acceptance:** a unit test creates a chain 9 levels deep and a subagent with a missing parent, and neither gets unrestricted tools.
- **Size:** S. **Depends on:** none. **Status:** Needs-verification (code confirmed; whether the harness permits that depth is unchecked).

## SEC-11: Worker reports pass unbounded, untrusted text to the router
- **Evidence:** `src/app/tools/executor.ts:79` has no maximum on `summary`. `src/executor/dsh.ts:417-420` relays failure text. `src/executor/dsh.ts:258` puts prepare output in the failure message.
- **Failure:** a misled worker can inject instructions into the router, which holds reply tools, or fill its context. Prepare output can also carry secrets into the router and on to a public reply.
- **Fix:** cap report length, pass reports to the router as structured fields marked untrusted, redact command output, and store long text behind a reference.
- **Acceptance:** tests show an oversized report is refused or truncated, and that prepare output with a fake token never reaches the relay text.
- **Size:** S. **Depends on:** none. **Status:** Confirmed-by-reading.

## COM-01: A timed-out evaluation is never reported to the requester
- **Evidence:** `src/core/evals.ts:62` records `unavailable`, `src/core/evals.ts` never calls the outbox, and `docs/002-authorization.md:151-155` shows the result only in the panel and health status.
- **Failure:** an allowed person asks the agent for work, the router is stuck or its model is down, and the person gets no answer.
- **Fix:** have the host send a templated failure reply on `unavailable` for addressed messages from authorized people, once per message.
- **Acceptance:** an engine test expires an explicit request three times and sees exactly one outbound failure message.
- **Size:** S. **Depends on:** none. **Status:** Confirmed-by-reading.

## COM-02: Ticket failure notices depend on the router choosing to send them
- **Evidence:** `src/executor/dsh.ts:417-420` relays the failure to the router only. `prompts/dispatch.md:59` asks it to relay blockers briefly.
- **Failure:** if the router is down, overloaded or misled, the requester never learns the work failed. The ticket shows as failed only in the panel.
- **Fix:** have the host send a templated message on `failed` and on launch failures, using the existing outbox and an idempotent ID. The router may add detail afterwards.
- **Acceptance:** a test with no router response still sees the failure message once, and a restart doesn't resend it.
- **Size:** S. **Depends on:** none. **Status:** Confirmed-by-reading.

## COM-03: Requests the host refuses get silence
- **Evidence:** `docs/006-deployment.md:274` lists "Nothing happens after a mention" as a troubleshooting case. `src/policy.ts:210` records refusal reasons only internally. `prompts/admission.md:23` says to ignore quietly, which is right for unaddressed messages only.
- **Failure:** a teammate who isn't on the list mentions the agent and can't tell whether it's broken.
- **Fix:** add an optional, rate-limited, fixed-text reply for addressed messages from unlisted people, off by default on public repos. Keep silence for unaddressed messages.
- **Acceptance:** tests cover on and off settings and the rate limit, and the text reveals nothing about the allowlist.
- **Size:** S. **Depends on:** WIP-3. **Status:** Confirmed-by-reading.

## ERR-01: Errors are classified by searching text
- **Evidence:** `src/executor/dsh.ts:44-45` and `:50-55`, `src/app/retry-health.ts:22`, `src/infra/commands.ts:29`.
- **Failure:** any error without a numeric status whose message contains `500`, `429`, or "rate limit" counts as temporary and is retried, so a permanent failure with one of those in its text wastes retries. Provider wording changes silently break budget detection.
- **Fix:** define a typed error model with kind, retryable flag, owner and a user-safe message. Map at each boundary and use structured status first.
- **Acceptance:** a table test shows an error mentioning `500 lines` isn't retried, and each boundary returns the typed form.
- **Size:** M. **Depends on:** none. **Status:** Confirmed-by-reading.

## ERR-02: Durable effects retry forever, and one bad relay blocks the rest
- **Evidence:** `src/app/effects.ts:109-113` and `:141-143` have no attempt cap. `src/app/sessions.ts:104-105` marks `relay` and `notice` as ordered. `docs/003-execution.md:161` confirms a failed one holds back later ones.
- **Failure:** one relay that can never succeed stops every later report and candidate from reaching the router. Health shows an error, but nothing recovers.
- **Fix:** add a dead-letter state after a set number of attempts or age, skip the poisoned row, notify the operator, and allow requeue from the panel.
- **Acceptance:** a test with a permanently failing relay shows later relays are delivered, and the failed one appears in the dead-letter view.
- **Size:** M. **Depends on:** none. **Status:** Confirmed-by-reading.

## REL-01: Recovery after a restart relies on the model to avoid repeating actions
- **Evidence:** `docs/003-execution.md:146` starts new Assignments with a note asking the worker to check before repeating outside actions. Worker `gh` and `lark-cli` calls have no idempotency.
- **Failure:** a restart during work can produce a duplicate PR, comment, or push if the model misjudges what already happened.
- **Fix:** route outside writes through the broker with idempotency keys and an action log, and give the recovery prompt that log.
- **Acceptance:** a test crashes after a side effect but before recording the turn, and the retry produces no duplicate.
- **Size:** L. **Depends on:** SEC-02. **Status:** Confirmed-by-reading.

## COST-01: No per-ticket limits on spend, time or turns
- **Evidence:** a search of `src` for budget, cost, turn and step limits finds only `src/app/retry-health.ts`, which reports provider budget failures. `prompts/work.md:33` says "Do not loop indefinitely". `docs/003-execution.md:35` caps background work after a turn, not the turn itself.
- **Failure:** a looping worker, or several, can spend without limit until the provider stops them.
- **Fix:** add configurable per-ticket and global caps on tokens, money, wall-clock time and tool calls. On reaching one, the host stops the worker and sends a templated message.
- **Acceptance:** tests with a fake model hit each cap, and each stops the ticket with a clear report.
- **Size:** M. **Depends on:** checking what usage data the harness exposes. **Status:** Confirmed-by-reading.

## COST-02: No rate limit on incoming events
- **Evidence:** the same search finds no intake limit. `src/core/intake.ts:20-59` stores and fans out every Trigger, and `src/policy.ts:206-208` turns unlisted follow-ups into candidates in `observe` and `auto`.
- **Failure:** comment spam on a public repo wakes workers and fills router turns, spending tokens. WIP-3 removes the worst path, but listed bots and CI remain.
- **Fix:** add per-thread and per-sender limits before any model is called, plus a global circuit breaker.
- **Acceptance:** a test sends 1,000 messages in a burst, and model-bound deliveries stay under the limit while dropped counts appear in health.
- **Size:** S. **Depends on:** WIP-3. **Status:** Confirmed-by-reading.

## CAP-01: No real Watchdog
- **Evidence:** the article's section 6 describes one. A search of `src`, `docs`, `prompts`, and `scripts` for "watchdog" finds nothing. `docs/006-deployment.md:133` is an hourly LLM prompt in another profile, and only reports status.
- **Failure:** a crash waits up to an hour, the check itself depends on a model, and a worker that is alive but stuck is never detected.
- **Fix:** add a separate, non-LLM supervisor for liveness and progress signals, such as no commits or tool activity. It should restart, stop or alert under fixed rules, with the LLM only helping diagnose.
- **Acceptance:** tests kill the service and simulate a stalled worker, and each is handled within a set time with no model calls.
- **Size:** M. **Depends on:** COST-01 for shared limits. **Status:** Confirmed-by-reading.

## TEST-01: Nothing tests against the real harness
- **Evidence:** `tests/fixtures/host.ts:177` mocks `restrict` and `guard`, and `:242` mocks permission presets, so tool limits are only recorded, never enforced. Peer packages are `0.2.1-alpha.2` (`package.json:55`).
- **Failure:** a preset or restriction change can pass every test and still break or weaken a real deployment. WIP-1 is exactly this kind of change.
- **Fix:** add a smoke test that boots real DeepSeek Harness with the bundle and a fake model, then verifies each role's real tool list and one full ticket.
- **Acceptance:** the test fails if `bash` is available to the router, and runs in CI without a real model key.
- **Size:** M. **Depends on:** none. **Status:** Confirmed-by-reading.

## TEST-02: No CI or security regression gate
- **Evidence:** the repo has no `.github` directory. `README.md` documents `pnpm check` only.
- **Failure:** the security behavior from WIP-1 to WIP-6 can regress without anyone noticing.
- **Fix:** add CI that runs `pnpm check`, a dependency audit and the attack tests, and fails on any regression.
- **Acceptance:** CI runs on pull requests, and a deliberately reverted guard fails it.
- **Size:** S. **Depends on:** the repo being public or on GitHub. **Status:** Confirmed-by-reading.

## PKG-01: Rebrand as Super-agent 2.0 without implying DeepSeek's involvement
- **Evidence:** `package.json:2` (`dsh-superagent`), `package.json:3` (author is the DeepSeek Harness team), `README.md:3` and `:7`, `LICENSE:3`.
- **Failure:** "2.0" reads as DeepSeek's official next version, and the current README calls it a DeepSeek prototype. Removing their notice would break the MIT terms.
- **Fix:** display name **Super-agent 2.0**, repo and package `super-agent-2`. Keep the `LICENSE` text and its copyright line, adding your own beside it. Add this line near the top of the README: "Independent community project. Not affiliated with or endorsed by DeepSeek." Describe the upstream as the fork's origin, and use no DeepSeek logo. Keep the hyphen and the `2`: `superagent` is an npm HTTP client, and `superagent-ai/superagent` is an AI security product. Re-check GitHub, npm and X before publishing.
- **Acceptance:** the README has the notice, `LICENSE` keeps the original copyright, a package name check passes, and the docs don't suggest DeepSeek endorsement.
- **Size:** S. **Depends on:** the operator's OK before anything goes public. **Status:** Confirmed-by-reading.

## DOC-01: No threat model or security policy, and docs overstate protection
- **Evidence:** no `SECURITY.md`. `docs/002-authorization.md:5` says the host enforces permissions and messages cannot change them, while the router could save policy (`src/app/tools/main.ts:249`). `docs/006-deployment.md:165` gives API callers panel permissions, including agents. A search of `docs`, `SETUP.md` and `README.md` for "threat", "prompt injection" and "trust" finds only `docs/007-architecture.md` and `docs/008-cookbook.md`, with no threat model in either.
- **Failure:** operators assume protections that don't exist and connect the agent to public repos.
- **Fix:** add `SECURITY.md` with a threat model, what is and isn't protected, a reporting address, and a clear warning about public repos until SEC-01 and SEC-02 are done. Make the docs match.
- **Acceptance:** each claim names the control and the test behind it, and `README.md` links the file.
- **Size:** S. **Depends on:** WIP items landing. **Status:** Confirmed-by-reading.

---

# P2: reliability, capability and quality

## ERR-03: Misleading setup error from any git failure
- **Evidence:** `src/infra/environment.ts:141-142`.
- **Failure:** a timeout, missing `git` or a permissions problem all report `gitTooOld`, so the operator upgrades git for nothing.
- **Fix:** catch only the "no match" exit, and report other failures with their real cause.
- **Acceptance:** a test with a failing subprocess gets the real error.
- **Size:** S. **Depends on:** none. **Status:** Confirmed-by-reading.

## ERR-04: Preset re-selection failure is swallowed
- **Evidence:** `src/app/sessions.ts:130`.
- **Failure:** if re-selecting the bundle's preset fails, a session can stay on the default preset and its tools, and nothing records it. This matters more after WIP-1, since the default preset may include a shell.
- **Fix:** log and raise health, and refuse to run the session on the wrong preset.
- **Acceptance:** a test with a failing `select` sees a health error and no turn starts.
- **Size:** S. **Depends on:** coordinate with WIP-1. **Status:** Needs-verification (swallowing confirmed; effect on tools under the real harness unchecked).

## ERR-05: Any Feishu warning leaves health stuck on error
- **Evidence:** `src/sources/feishu-loops.ts:84` treats any stderr line matching `WARN`, `drop`, or `error` as an error. Only the `[event] ready` line resets it at `:83`.
- **Failure:** a harmless warning after startup makes `status` exit 2 until the consumer restarts, and the hourly check keeps alerting on it.
- **Fix:** parse structured levels, add a timed recovery, and report warnings separately.
- **Acceptance:** a test sends a warning and then normal events, and health returns to ready.
- **Size:** S. **Depends on:** none. **Status:** Confirmed-by-reading.

## ERR-06: Raw error text flows to models and the panel unredacted
- **Evidence:** `src/sources/poll.ts:28`, `src/app/effects.ts:143`, `src/infra/commands.ts:29`, `src/executor/dsh.ts:557`, `src/app/http.ts:81` and following.
- **Failure:** CLI stderr can carry tokens, URLs or private text into the database, the router's cards, a worker's prompt, and API responses.
- **Fix:** add one redaction function at the error boundary, and keep full text only in a local log.
- **Acceptance:** tests pass a fake token through each path, and it never appears in the stored or displayed text.
- **Size:** S. **Depends on:** ERR-01. **Status:** Confirmed-by-reading.

## COM-04: "Ready" and test results are the model's own claims
- **Evidence:** `src/app/tools/executor.ts:75-83` takes free text, and `prompts/work.md:46-49` defines ready in words. `claimPull` checks PR ownership, but nothing checks that tests ran.
- **Failure:** a worker can report that tests passed when they didn't, and the router relays it as fact.
- **Fix:** record exit codes and CI state from the host, include them in reports, and label anything unverified.
- **Acceptance:** a test where a worker claims success with failing CI produces a report that shows the failure.
- **Size:** M. **Depends on:** none. **Status:** Confirmed-by-reading.

## COM-05: Operators are alerted only through the panel and hourly check
- **Evidence:** `docs/002-authorization.md:155`, `docs/006-deployment.md:133`, `docs/003-execution.md:161`.
- **Failure:** a stalled effect or a Source failure sits unseen until someone opens the panel or the hourly check runs.
- **Fix:** add alerts to a configured channel, deduplicated, with a digest for lower-priority problems.
- **Acceptance:** a test raises an error and sees one alert, plus one recovery message.
- **Size:** S. **Depends on:** CAP-01. **Status:** Confirmed-by-reading.

## REL-02: Stored data is never pruned
- **Evidence:** the only row deletions outside migrations are at `src/app/effects.ts:80` and `:135`, `src/app/store.ts:129`, `:173` and `:287`. `src/app/store.ts:251` says receipts are kept permanently.
- **Failure:** triggers, decisions, threads and tickets grow without limit on a busy repo, which raises the risk of slow queries and a large database.
- **Fix:** add a retention policy with archived exports, keeping the receipt IDs that idempotency needs. Add a size metric to health.
- **Acceptance:** a test seeded with old rows prunes them and leaves live tickets and idempotency intact.
- **Size:** M. **Depends on:** none. **Status:** Confirmed-by-reading.

## REL-03: Ticket directories and branches are never cleaned up
- **Evidence:** `src/executor/dsh.ts:257` removes only an empty directory after a failed prepare. `prompts/work.md:38` forbids workers deleting them. `docs/006-deployment.md:153` creates a worktree and branch per Ticket.
- **Failure:** disk use grows with every ticket, and stale worktrees and `agent/*` branches pile up.
- **Fix:** clean up after a retention period once a ticket has ended and its PR is closed, and keep what a resume needs.
- **Acceptance:** a test ends a ticket, passes the retention time, and sees the directory removed, while a resume still works by recreating it.
- **Size:** M. **Depends on:** SEC-01, which may change where directories live. **Status:** Confirmed-by-reading.

## REL-04: Delivery state may grow with session history
- **Evidence:** `src/app/delivery.ts:44-56` reads a session's whole history on first delivery, and `:32` keeps every delivered ID in memory.
- **Failure:** the long-lived router session could make startup and memory use worse over months.
- **Fix:** measure it, then persist delivered IDs in SQLite with a bound.
- **Acceptance:** a benchmark with a large synthetic history stays within a set startup and memory limit.
- **Size:** S. **Depends on:** none. **Status:** Needs-verification.

## REL-05: The GitHub stream silently skips anything older than 14 days
- **Evidence:** `src/sources/poll.ts:6`, `src/sources/github.ts:209-210`.
- **Failure:** after an outage longer than 14 days, older events in the observed repository stream are skipped and nothing says so.
- **Fix:** record the gap in health and the panel, and optionally offer a catch-up.
- **Acceptance:** a test with an old cursor reports the skipped period.
- **Size:** S. **Depends on:** none. **Status:** Confirmed-by-reading.

## REL-06: Service script and health checks are Unix-only and tied to tmux
- **Evidence:** `scripts/dsh-superagent:10`, `:166`, while `cordis.patch.yml` includes Windows paths such as `tool-pwsh`.
- **Failure:** Windows support in the preset has no matching service script, and tmux is a poor fit for servers.
- **Fix:** add a systemd unit and a Docker image, and either support Windows properly or remove it.
- **Acceptance:** the documented install starts and restarts under systemd or Docker.
- **Size:** M. **Depends on:** SEC-01. **Status:** Confirmed-by-reading.

## CAP-02: No compute, state and execution separation
- **Evidence:** article section 5 against `src/app/store.ts:60` (local SQLite), `src/app/runtime.ts:93` (a file lock on one state directory), and `src/app/http.ts:231` (loopback only). The README warns that some designs are not implemented.
- **Failure:** the agent stops when its one machine does, so it can't stay online across devices.
- **Fix:** define a store interface with a Postgres or similar option, move the agent loop into a stateless service, and add endpoint daemons with mutual authentication. Treat the daemon channel as hostile: article section 8.4 warns that a compromised loop could take over every endpoint.
- **Acceptance:** killing the host mid-ticket and starting it elsewhere continues the ticket, and a compromised-loop test can't run commands outside a ticket's allowed scope.
- **Size:** L. **Depends on:** SEC-01, SEC-02. **Status:** Confirmed-by-reading.

## CAP-03: Polling only, with no webhook intake
- **Evidence:** `src/sources/github.ts:144` waits at least `pollSeconds`, with a default and minimum of 60 at `src/sources/github.ts:25`. A search for `x-hub-signature` finds nothing. `docs/006-deployment.md:33` explains that notifications force a user account.
- **Failure:** responses lag up to a minute or more, and the account model blocks GitHub Apps.
- **Fix:** add a webhook receiver with signature checks and replay protection, keeping polling as the catch-up path.
- **Acceptance:** tests accept a signed event, reject bad signatures and replays, and deduplicate with polling.
- **Size:** M. **Depends on:** SEC-02 for the App model. **Status:** Confirmed-by-reading.

## CAP-04: One repository per deployment
- **Evidence:** `README.md:7`, `src/infra/commands.ts:94-98`, and `DSH_SUPERAGENT_GITHUB_REPOSITORY` in `docs/003-execution.md`.
- **Failure:** a team with several repos needs a separate service, policy and router for each, which loses shared context.
- **Fix:** add repo identity to Thread keys and Mandates, per-repo Policy, and a migration.
- **Acceptance:** a two-repo test keeps permissions separate, and a request in one can't act on the other.
- **Size:** L. **Depends on:** SEC-02. **Status:** Confirmed-by-reading.

## CAP-05: No speculative execution
- **Evidence:** article section 3.4 against the code: a search finds no such mode, and the default rules at `src/policy.ts:62-65` cover copy and visual fixes.
- **Failure:** the "silently reproduce and fix" behavior the article features is unavailable.
- **Fix:** add it only after isolation: run in a sandbox with no outward actions, and hold results until a person accepts them.
- **Acceptance:** a test shows speculative runs have no write credentials and discard unused results.
- **Size:** L. **Depends on:** SEC-01, SEC-02, COST-01. **Status:** Confirmed-by-reading.

## CAP-06: Limited channels, and no long-term memory
- **Evidence:** only GitHub and Feishu Sources exist in `src/sources`. `docs/008-cookbook.md` explains how to add one. Article section 8.1 names long-term memory as open.
- **Failure:** teams on Slack, Discord or email can't use it, and older context fades once it leaves the router's history.
- **Fix:** add a Slack Source first, then long-term memory that keeps provenance and treats recalled text as untrusted.
- **Acceptance:** a Slack Source passes the same Source tests, and memory retrieval keeps trust labels.
- **Size:** L. **Depends on:** SEC-06 for memory. **Status:** Confirmed-by-reading.

## TEST-03: Published experiments can't be reproduced from this repo
- **Evidence:** article section 7 reports results. The repo has no benchmark scripts or data. `src/core/evals.ts` is the assessment engine, not an experiment.
- **Failure:** nobody can check the claims, or compare a fork against them. The article also used a tool that only burns time in place of real coding.
- **Fix:** add a benchmark harness that replays a message stream, reports completion times and tokens, and includes real coding tasks.
- **Acceptance:** one command reproduces a results table for a pinned model and seed.
- **Size:** M. **Depends on:** TEST-01. **Status:** Confirmed-by-reading.

## QUAL-01: Dependence on untyped harness internals and alpha packages
- **Evidence:** `src/app/sessions.ts:129` casts a service to an inline type, `package.json:55` pins alpha versions, and a search finds 10 `as unknown as` or `as never` casts in `src`. `src/app/store.ts:2` uses the experimental `node:sqlite`.
- **Failure:** harness updates can break behavior silently, including security-relevant tool limits.
- **Fix:** isolate the harness behind one adapter, pin exact versions, and cover it with TEST-01.
- **Acceptance:** all harness calls go through the adapter, and casts in other modules are gone.
- **Size:** M. **Depends on:** TEST-01. **Status:** Confirmed-by-reading.

---

# P3: cleanup and polish

## SEC-12: Mention detection ignores quotes and code blocks
- **Evidence:** `src/sources/github-trigger.ts:60-61`.
- **Failure:** a listed person quoting text that contains the agent's handle, or showing it in a code block, counts as addressing the agent and can start a ticket.
- **Fix:** strip fences, inline code and quoted lines before matching.
- **Acceptance:** tests cover quoted and fenced mentions as not addressed.
- **Size:** S. **Depends on:** none. **Status:** Confirmed-by-reading.

## SEC-13: An edited comment keeps its original author's authority
- **Evidence:** `src/sources/github-trigger.ts:67-68` includes `updated_at` in the Trigger ID, so an edit becomes a new Trigger with `comment.user` as its actor.
- **Failure:** someone with write access edits a listed person's comment, and the edit counts as that person's request. This depends on GitHub allowing that edit and on no edit-author check.
- **Fix:** treat edits as lower authority, or check who made the edit through the API.
- **Acceptance:** a test with an edited comment doesn't produce an explicit request.
- **Size:** S. **Depends on:** none. **Status:** Needs-verification.

## SEC-14: Model-supplied Feishu cursor goes to a CLI argument unchecked
- **Evidence:** `src/sources/feishu-read.ts:52` decodes the cursor, and `:78` passes it as `--page-token`. The assessment path checks cursors against a known set (`src/app/assessment.ts:255`), but this worker path has no equivalent check.
- **Failure:** a crafted value could be misread by the CLI. Whether `lark-cli` allows that hasn't been checked.
- **Fix:** validate the cursor format, or track issued cursors as the assessment path does.
- **Acceptance:** a test rejects a cursor that isn't one the host issued.
- **Size:** S. **Depends on:** none. **Status:** Needs-verification.

## COM-06: Host notices support only Chinese and English
- **Evidence:** `src/sources/github-pull.ts:98` guesses the language from Han characters.
- **Failure:** other languages get English, and Han-script text in another language gets Chinese.
- **Fix:** use a shared template system with configurable language.
- **Acceptance:** tests cover a configured language and a fallback.
- **Size:** S. **Depends on:** COM-01, COM-02, which add more templates. **Status:** Confirmed-by-reading.

## COM-07: The IM word cap counts link text and URLs and throws on send
- **Evidence:** `src/infra/text.ts:11-14`, `src/app/outbox.ts:29`.
- **Failure:** a short message with long links can be refused and must be rewritten. A host-generated message over the limit would throw.
- **Fix:** exclude URLs from the count, and truncate host messages rather than throwing.
- **Acceptance:** tests cover a message with long URLs and an oversized host notice.
- **Size:** S. **Depends on:** none. **Status:** Confirmed-by-reading.

## QUAL-02: Legacy migrations and project names remain
- **Evidence:** `src/app/migration.ts` (616 lines) and `tests/migration.spec.ts` (539 lines). `src/infra/environment.ts:16` lists `dsh-tag`, `dsh-go` and `dsh-freelancer`. `src/app/resources.ts:301` accepts old prefixes. `src/app/delivery.ts:18-23` keeps legacy sources.
- **Failure:** a new fork has no old databases to migrate, yet carries over 1,000 lines for them.
- **Fix:** start the fork at a fresh schema, and delete the migrations and legacy names once nobody needs an upgrade path from upstream.
- **Acceptance:** a fresh install and the full test suite pass with the code removed, and a clear error explains that upstream databases aren't supported.
- **Size:** M. **Depends on:** the operator's decision on upstream upgrades. **Status:** Confirmed-by-reading.

## QUAL-03: Inconsistent names across code, API and docs
- **Evidence:** `dsh-superagent` appears in 78 files and `orchestrator` in 70, with 141 `orchestrator_` references and `DSH_SUPERAGENT_*` in 25 files. Examples are `/orchestrator/api` at `src/app/http.ts:234` and `x-orchestrator-request`. The docs say main Session, the prompts say orchestrator, and the article says Router.
- **Failure:** the mix confuses contributors and agents, and the old name stays visible after the rebrand.
- **Fix:** after the WIP items land, pick router and worker, and rename in one mechanical pass with an upgrade note. Do this late, because it touches almost everything.
- **Acceptance:** a search for old names finds only intended compatibility entries, and tests pass.
- **Size:** M. **Depends on:** PKG-01 and all WIP items. **Status:** Confirmed-by-reading.

## QUAL-04: Dense code style
- **Evidence:** 132 lines over 180 characters across `src/core`, `src/app`, `src/executor` and `src/sources`. The README warns the code was largely written by agents and may be inconsistent.
- **Failure:** reviews are harder, which matters in security-sensitive code.
- **Fix:** add a formatter and linter in a dedicated commit, separate from behavior changes.
- **Acceptance:** CI enforces both, and that commit changes no behavior.
- **Size:** S. **Depends on:** do this after the WIP items to avoid conflicts. **Status:** Confirmed-by-reading.

## DOC-02: Setup expects an agent and is tied to Feishu-era defaults
- **Evidence:** `README.md:13`, `SETUP.md`. `src/client/locales.ts` puts Chinese first, and some panel labels and preset descriptions are Chinese only (`cordis.patch.yml`).
- **Failure:** a new user without a coding agent, or who doesn't read Chinese, has a harder start.
- **Fix:** add a short manual quickstart, ideally a Docker one, and review English coverage in the panel.
- **Acceptance:** a person can follow the README alone to a first ticket, and an English UI check finds no untranslated strings.
- **Size:** S. **Depends on:** SEC-01 for the safe Docker path. **Status:** Confirmed-by-reading.

## DOC-03: Docs need updating when WIP lands
- **Evidence:** `docs/002-authorization.md:20`, `:50-54` and `:127`. `docs/003-execution.md:27` and `:29`. `docs/004-prompts.md:38`. `docs/006-deployment.md:159-167`. `docs/007-architecture.md:501`. The preset comment at `cordis.patch.yml` for the router.
- **Failure:** the docs would keep describing removed tools, stranger follow-ups and header-only API access.
- **Fix:** update each one in the same change as its code, and add a CHANGES section against upstream.
- **Acceptance:** a search for removed tool names finds no doc references, and `tests/docs.spec.ts` passes.
- **Size:** S. **Depends on:** WIP items. **Status:** Confirmed-by-reading.

## PKG-02: Missing project files for a public release
- **Evidence:** `package.json:6` is `"private": true`, and it has no `repository` field. The repo root has no `CONTRIBUTING.md`, `CHANGELOG.md`, or issue templates.
- **Failure:** the package can't be published as is, and contributors have no guidance.
- **Fix:** add those files, set package metadata, publish only after the security items are done, and reserve the names early.
- **Acceptance:** `npm pack --dry-run` lists the expected files, and a test install works.
- **Size:** S. **Depends on:** PKG-01. **Status:** Confirmed-by-reading.

## PKG-03: Tell DeepSeek before publishing security findings
- **Evidence:** the upstream repo has issues disabled and 991 forks, so others may be running this code.
- **Failure:** a public post without notice could expose people running the unpatched prototype.
- **Fix:** find a contact and send a private summary first. Publish behavior and fixes, not working payloads, and test only against your own repos.
- **Acceptance:** the date and channel of the notice are recorded, and launch material has no payload.
- **Size:** S. **Depends on:** SEC-04, so the report is accurate. **Status:** Confirmed-by-reading.
