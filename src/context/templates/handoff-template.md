# Handoff Note

## Metadata

- **Task ID**: TASK-YYYY-MM-DD-NNN
- **Timestamp**: YYYY-MM-DDTHH:MM:SS.000Z
- **Trigger**: compaction | sub-agent-complete | manual
- **Status**: current task status (e.g., in-progress, blocked, review)

## Progress

_Describe what has been accomplished so far. Be specific about completed work, partial implementations, and current state. This section should allow someone picking up the task to understand where things stand._

Example:
- Implemented core authentication flow (login/logout)
- Added JWT token generation and validation
- Created user profile endpoint
- Tests written for happy path, edge cases pending

## Blockers

_List any issues preventing forward progress. Include context about why each is blocking and what's needed to unblock._

Example:
- Waiting for API key from external service provider
- Database schema migration blocked by infrastructure team approval
- Design mockups needed for settings page

If none: **None**

## Next Steps

_List specific actions that need to happen next. Be concrete and actionable._

Example:
- Complete edge case tests for authentication
- Integrate with email service for password reset
- Add rate limiting to login endpoint
- Update API documentation

If none: **None**

## Key Decisions

_Document important technical or architectural decisions made during this work. Include rationale where helpful._

Example:
- Chose JWT over session cookies for stateless API design
- Using bcrypt with cost factor 12 for password hashing
- Decided to implement refresh token rotation for security
- Opted for REST over GraphQL to reduce complexity for this use case

If none: **None**

## Artifacts

_List files created or significantly modified. Include paths from project root._

Example:
- src/auth/jwt.ts
- src/auth/middleware.ts
- src/routes/auth.ts
- tests/auth.test.ts
- docs/api/authentication.md

If none: **None**

## Dependencies

_List other tasks or external dependencies this work relies on or blocks._

Example:
- Depends on: TASK-2026-02-06-001 (user model schema)
- Blocks: TASK-2026-02-07-003 (OAuth integration)
- Related to: TASK-2026-02-05-002 (security audit)

If none: **None**

---

## Usage Notes

This template is provided as a guide for agents writing handoff notes. When creating a handoff note:

1. **Be specific**: Avoid vague statements like "made progress" — detail what was done
2. **Be actionable**: Next steps should be clear enough for another agent to pick up immediately
3. **Document decisions**: Future agents need to understand *why* choices were made
4. **Keep it concise**: Target 1-2K tokens — enough detail to be useful, not a full narrative

Handoff notes are written to:
- `tasks/<status>/<task-id>/outputs/handoff.md`

They are automatically included in context assembly for task resumption.
