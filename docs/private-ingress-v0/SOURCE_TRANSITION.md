# Private Ingress source transition plan

## Scope

PI-05 prepares an exact, reviewable target for a later production operator transition. It does not
change a production repository allowlist, service, listener, data path, DNS, route, firewall, or TLS
material. Those changes remain separate PI-07/PI-08 approval boundaries.

## Exact candidate identity

Every private-ingress v2 distribution plan contains a `sourceTransition.exactTarget` with:

- the artifact manifest's exact 40-character source commit;
- the verified artifact manifest and payload SHA-256 digests;
- the rendered Gateway configuration digest.

The repository identity accepted by the production operator remains operator-private input. Before
cutover, the operator must bind that exact repository identity to all four candidate values and
issue a fresh approval. A matching public commit alone does not authorize a production deployment.

## Verification sequence

1. Keep the pre-existing deployment, data, service labels, source admission and listener unchanged.
2. Verify the operator-private repository identity and the plan's exact source commit.
3. Verify the expanded artifact manifest, payload and rendered Gateway configuration digests.
4. Install the candidate into an isolated package namespace and non-canonical private listener.
5. Run redacted `status` and `doctor`, then perform the PI-07 external-device acceptance matrix.
6. Stop if the operator admission rejects the repository, commit or artifact. Do not bypass it with
   a manual production command.

## Rollback sequence

Before a canonical cutover, rollback means stopping only the isolated package-owned candidate and
leaving the pre-existing deployment active. After an approved cutover, restore the previous
immutable receipt and listener, verify its readiness, and preserve both deployments through the
3–7 day soak. Deletion, source-admission replacement and legacy cleanup require their own later
approval.
