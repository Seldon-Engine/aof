# AOF Context Budget
Token cost estimation for each AOF prompt file (assumes ~4 chars/token average).

| File | Lines | Bytes | Est. Tokens | Inject? | Notes |
|------|-------|-------|-------------|---------|-------|
| agent-guide.md | 17 | ~1.1 KB | ~275 | ✅ Every turn | Core workflow; mandatory for AOF-aware agents |
| integration-guide.md | 154 | ~7.4 KB | ~1850 | 🟡 Once only | Used during integration; not needed post-setup |
| tool-descriptions.md | 48 | ~2.5 KB | ~625 | ❌ Reference only | Examples/troubleshooting; adapter descriptions + agent-guide sufficient for routine use |
| AOF.md (per-agent) | 6 | ~0.4 KB | ~100 | ✅ Every turn | Quickstart reminder; negligible cost |

**Total injected per turn:** ~375 tokens (agent-guide.md + per-agent AOF.md).
**Recommendation:** Inject agent-guide.md and per-agent AOF.md; keep tool-descriptions.md as reference documentation.
