# Contributing

Contributions are welcome under the MIT license. Discuss substantial API or
transport changes in an issue before implementing them.

Use Node.js 22 or later, run `npm ci`, and run `npm run check` before opening
a pull request. Add tests when behavior or a meaningful invariant needs
verification. Use Arrange, Act, Assert (AAA) in tests.

The catalog and file-access logic lives in `src/catalog.ts`. MCP registrations
live in `src/server.ts`; transport and CLI configuration live in their own
modules. Keep stdout reserved for MCP messages in stdio mode.

Skills use the Agent Skills `SKILL.md` format. Put examples in nested folders
under `skills/` to keep recursive discovery visible. Keep instructions focused
and descriptions specific enough for an agent to choose the correct workflow.

Do not commit credentials, internal company skills, generated builds, or local
configuration. Include the behavior change and relevant validation in PRs.
