# Session lifecycle

## Discover before acting

Use `list --json` with a bounded limit to identify the intended Session, lifecycle, revision, current
runtime ID, and controller generation. Do not choose a Session from an old ID, pane label, terminal
text, or guessed creation order. Use the returned cursor when more results are needed.

Use `watch SESSION_ID --json --once` for one bounded read. A longer watch must still use explicit
limits and timeouts and should end when the requested observation is complete. Never treat an empty
event batch as proof that a process is idle or safe to take over.

## Start a Session

Prefer the installed, allowlisted profile path:

- name the exact profile and root IDs;
- keep cwd relative to the registered root;
- choose terminal dimensions deliberately; and
- let Host policy resolve the executable and environment.

Arbitrary exec is a separate high-risk path. It requires a private JSON file matching
`ExecCommandSpecV0`, explicit `--allow-arbitrary-exec`, an allowlisted root, and named environment and
resource policies. The spec must not contain inline secrets or an unreviewed shell wrapper. Do not use
arbitrary exec to bypass a missing profile or root-policy denial.

`run` creates a new Session. The current CLI does not expose a command to restart a stopped Session
or forget metadata; report that gap rather than creating a lookalike replacement and calling it a
resume.

## Stop with current fencing

Stopping is destructive to the current runtime even though Session metadata remains. Immediately
before proposing it:

1. obtain fresh `list --json` output;
2. match the exact Session ID and confirm it is the intended process;
3. record its current revision and runtime ID;
4. identify whether it hosts the current agent or another active controller; and
5. use those exact fencing values only after the user's stop intent covers that runtime.

On `RUNTIME_STALE` or `SESSION_REVISION_STALE`, inspect again and explain what changed. Do not refresh
the values and retry automatically: a replacement runtime is a different destructive target.
