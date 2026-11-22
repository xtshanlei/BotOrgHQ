# Proactive autonomy architecture

## M0 baseline

BotOrgHQ v0.3.0 uses DSH 0.2.2-rc.2 and DS Bot 0.3.1. The original organisation JSON,
native Bot sessions, memory, task board and desktop updater remain the owners of their
existing data. The baseline passed ten tests and built the DSH client bundle. The
standalone app runs the plugin in a child Node process using its existing DSH home.

The engine uses Node 24's built-in SQLite in that DSH home. The plugin already requires
Node >=24.9 and desktop packaging copies the actual platform's Node executable.
SQLite is additive, uses WAL and full synchronisation, and falls under the existing
desktop backup. No original data is migrated into it.

DSH authenticates Fetch routes before handing them to plugins. An administrative
operation also requires the owner capability and same-origin browser request checks.
Bot identity comes from the DS Bot session, never a model argument. Webhooks use
separate HMAC verification and project bindings. External payloads are treated as
data with bounded projections.

## Delivery sequence

1. M1 and M2 add transactional storage, inherited policy, ceilings, goal versions,
   persistent triggers and authenticated ingress.
2. M3 adds bounded configured-model calls, Chief planning, scoped delegations,
   dependency execution, evidence and recovery.
3. M4 adds expiring approvals and invalidation checks at execution boundaries.
4. M5 and M6 expose the engine in the existing workbench and harden the native
   lifecycle, backups, export and cross-platform verification.

The pinned DS Bot handoff starts a normal recipient chat turn. That turn may access
the Bot's skills, external adapters, scheduler and tools, including paths outside
the DSH native tool guard. A tool guard alone therefore cannot safely wrap it as
unrestricted autonomous work. The bounded executor uses real roster identities and
configured session models, with an explicit host-owned capability list, no model tool
registrations, and persistent task board handoffs. Manual chat and native message_bot
retain their existing behaviour.
