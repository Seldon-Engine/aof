# Mailbox View (Derived)

**Purpose:** Provide per-agent mailbox folders derived from the canonical task store.
The mailbox is a **computed view** — it is not a source of truth.

## Directory Layout

```
Agents/
  <agent>/
    inbox/
    processing/
    outbox/
```

## Pointer File Format

Each mailbox entry is a small Markdown **pointer** file. It contains minimal
metadata plus a relative path to the canonical task file in `tasks/`.

Example (`Agents/swe-backend/inbox/TASK-2026-02-07-002.md`):

```
---
id: TASK-2026-02-07-002
title: P2.2 Mailbox view (computed)
status: ready
agent: swe-backend
priority: high
---

# P2.2 Mailbox view (computed)
Canonical: ../../../tasks/ready/TASK-2026-02-07-002.md
```

- The pointer file is **derived** and can be regenerated at any time.
- The canonical task file is always in `tasks/<status>/`.
- Relative paths are used for portability across OS.

## Mapping Rules

Mailbox buckets are derived from task status:

- **inbox** → `ready`
- **processing** → `in-progress`, `blocked`
- **outbox** → `review`

Task-to-agent ownership uses the first available signal:

1. `frontmatter.lease.agent`
2. `frontmatter.routing.agent`
3. `frontmatter.metadata.assignee`

Tasks without an explicit agent are **not** included in mailbox views.
