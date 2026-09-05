# Application authorization and DurableSession Host

The trust chain is intentionally layered:

```text
Gateway assertion verification
  -> application resource authorization
  -> registered Host app credential + least-privilege caller context
  -> Host capability and scope enforcement
```

Never pass a Gateway assertion to DurableSession Host or translate it mechanically into an
unrestricted caller context. The app chooses a subject and capability/scope delegation only after
its own policy allows the requested action.

Use `@naru/durable-session-client` for protocol operations and the Node subpath for a private UDS.
Load the separately provisioned Host app credential with `readPrivateCredentialFile`; the file must
be owner-only, regular, and free of symlinks. Do not put the credential in argv, environment examples,
JSON, logs, browser storage, or Gateway claims.

A caller context contains:

- registered `appId` and application-authorized `subject`;
- only the required granular capabilities;
- explicit Session, profile, and root scopes;
- a short expiry within the Host registration's maximum.

Common read-only access needs `session:observe`. Control requests need `control:request` and a current
attachment; preempt is a distinct `control:preempt` capability and must remain an explicit owner
action. Profile creation and arbitrary execution are separate capabilities; do not grant arbitrary
execution by default.

Host validates the app credential and clamps the caller context to the registered app policy. Test
wrong credentials, wrong subject, expired caller, excess capability, and excess Session/profile/root
scope. A denial must not fall back to a more privileged local identity.
