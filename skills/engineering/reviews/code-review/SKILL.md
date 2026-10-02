---
name: code-review
description: Review code changes for correctness, regressions, and missing validation when asked to review a patch or pull request.
license: MIT
metadata:
  version: "1.0.0"
---

Read [the checklist](references/checklist.md) when reviewing changes.
Focus on concrete problems introduced by the patch. Explain each finding's
trigger, impact, and location. Distinguish verified failures from assumptions.
If no actionable issues are found, say so and describe the validation limits.
