# 2026-02-06 — AOF review

- Compare implementation against DOF/BRD specs early; status taxonomy and task ID formats can drift quickly.
- Favor atomic filesystem transitions (`rename`) for SSOT artifacts to avoid duplicate-state edge cases.
- When providing CLI dot-path config, ensure array-by-id addressing is implemented or documented to avoid misleading UX.
