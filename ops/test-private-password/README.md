# Isolated Claude Code password acceptance server

This is a temporary, non-production Naru instance on private HTTPS port 9443. It uses its own
password, session cookie, database, project root, web build and LaunchAgent. The installed
Workstation Host, Gateway, Naru services and their data are not changed or restarted. It reads the
operator-approved TLS certificate and key using the shared material validator, with exact private
IPv4 source admission. It does **not** test Gateway passkeys or DurableSession Host continuity.

Run from the repository root with Node 24 on the owner Mac:

```sh
node --import tsx ops/test-private-password/prepare.ts check
node --import tsx ops/test-private-password/prepare.ts prepare
```

`prepare` prints the newly generated `/private/tmp/naru-claude-9443.<id>` root. It refuses to
replace an existing Keychain password. It retains the root by design. Start the new test-only
LaunchAgent with `launchctl bootstrap gui/$(id -u) <root>/launch-agent.plist`; verify it with
`node --import tsx ops/test-private-password/smoke.ts <root>`. The browser acceptance script
`live-ui.ts` creates an isolated project and opens a real Claude Code Pane. It requires the owner
login session and Playwright Chromium.

For one user-approved existing project, run
`node --import tsx ops/test-private-password/configure-project.ts <root> <canonical-project-path>`.
This atomically pins the current Claude executable and one exact, owner-owned project root; it
does not admit sibling projects. Restart **only** this test LaunchAgent with
`launchctl kickstart -k gui/$(id -u)/dev.naru.claude-password-9443`. New projects on this isolated
server start with Claude Code 1, Claude Code 2 and Dev Terminal. Existing workspace layouts and
the production default remain unchanged. `open-project.ts <root> <canonical-project-path>` logs in
through a real browser, registers that one project, and verifies that two separate Claude runtimes
start without default Codex Panes. After a test Naru restart, run `restore-project.ts` with the
same root and canonical project path to start the stopped test Panes and verify browser reconnect
without changing the stored layout.

When the approved project has linked Git worktrees in its sibling `worktree` and `worktrees`
directories, run `node --import tsx ops/test-private-password/configure-worktree-roots.ts <root>`.
The script checks that both directories are canonical, owner-owned and readable, then atomically
adds them to the isolated server settings. Only their strict children become eligible projects;
the two directory roots, other siblings and symlink escapes remain excluded. Restart **only** the
test LaunchAgent with the `kickstart` command above, then use `restore-project.ts` to resume the
test Claude Panes. Linked worktrees appear as discovered targets; each requires an explicit
Connect action before Naru opens it. Production project roots and services remain unchanged.

The test URL can be read locally from `<root>/settings.json` (`browserOrigin`); the password is the
`dev.naru.claude-password-9443` generic password in the owner's macOS Keychain. Only exact
pre-approved private source addresses plus the listener's own address are admitted. If another
device is denied, review its address and approve a separate test source-policy change; do not
broaden production admission implicitly.

To stop **only** this test service, use
`launchctl bootout gui/$(id -u)/dev.naru.claude-password-9443`. This does not remove the retained
test state or Keychain item. Do not use Workstation deployment commands for this instance.
