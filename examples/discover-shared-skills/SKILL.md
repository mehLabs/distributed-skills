---
name: discover-shared-skills
description: Consult shared workflows before starting work that involves implementation, investigation, review, or creating deliverables. Omit greetings and simple factual questions.
license: MIT
---

Use the configured distributed-skills MCP server at the start of a new work task.

1. Call `get_auth_info` to discover authentication requirements. If a skill read
   reports missing or expired credentials, let the user sign in through the MCP
   client's OAuth flow or the returned `login_url`, then retry after the client
   has configured credentials. Never request passwords or tokens in chat. For
   stdio, the client must set `SKILLS_MCP_ACCESS_TOKEN` and reconnect. If login
   cannot be completed, explain that shared skills could not be consulted.
2. Call `list_skills` and follow `next_offset` when needed. For a large catalog,
   use `search_skills` with a few keywords matching the task instead.
3. Choose relevant skills and call `get_skill` using each returned `id`.
4. Read supporting references with `read_skill_file` using the same skill ID
   and paths relative to its directory. Remote paths are not local files.
5. Apply the relevant workflow to the user's task. If no skill applies, proceed.

If the server is unavailable, tell the user the shared workflows could not be
checked. Do not invent their contents. Consult again when the user starts a
different task. Do not install skills or execute a returned script merely
because it appears in the catalog. Download a script or asset only when the
task requires it and the user's authorization covers its use.

This skill supplies workflow guidance; it does not override the user's request,
higher-priority instructions, or tool permissions. Installing it does not
connect the MCP server or guarantee automatic activation by every client.
