# Changelog

## [1.19.1](https://github.com/d0labs/aof/compare/v1.19.0...v1.19.1) (2026-05-03)

### Bug Fixes

* **chat-delivery-poller:** tighten wake-prompt to prevent action bias and silent acks ([9c1e5c8](https://github.com/d0labs/aof/commit/9c1e5c89ec347fce4f4dc1994611bccb1d0f5532))
* **dispatch:** detect embedded-run silent failures and deadletter immediately ([76e8ea6](https://github.com/d0labs/aof/commit/76e8ea6e79c2e94abcf60dc1fa82601d2534ad52))

### Refactor

* **dispatch:** excise dormant platformLimit dynamic-throttling path ([23f2055](https://github.com/d0labs/aof/commit/23f20555a21788f48cf66c51648cc47ff899330d))
* **openclaw:** excise dead OpenClawAdapter class and barrel re-export ([01da21d](https://github.com/d0labs/aof/commit/01da21d65b01e07d03c408e895712af7a36ab6c4))

### Tests

* **adapter:** cover agent_end forwarding for Codex-shape event payloads ([fe4ea79](https://github.com/d0labs/aof/commit/fe4ea795dbc9a42bd5d807b0f597bb9fea7e3fcd))
* **e2e:** align tool-execution suite with Phase 46-05 routing contract ([a016b06](https://github.com/d0labs/aof/commit/a016b0660203c78139177afd991d056f482efd9f))

## [1.19.0](https://github.com/d0labs/aof/compare/v1.18.1...v1.19.0) (2026-04-29)

### Features

* **chat-delivery-poller:** inject completion notifications into dispatcher session context ([de5b6bd](https://github.com/d0labs/aof/commit/de5b6bd4ff2037230dac5f64d412d69286606508))

### Tests

* **drift:** bump LiveAdapter timeout to 30s to defuse pre-existing flake ([40fb387](https://github.com/d0labs/aof/commit/40fb3873c36f032170a880eba286e1cd11870fac))

## [1.18.1](https://github.com/d0labs/aof/compare/v1.18.0...v1.18.1) (2026-04-28)

### Bug Fixes

* **executor:** pass authProfileId explicitly + add setup-phase timeout to prevent dispatch ghosts ([b868328](https://github.com/d0labs/aof/commit/b86832845cb646d7824a053645a72ded8a83fe53))

## [1.18.0](https://github.com/d0labs/aof/compare/v1.17.4...v1.18.0) (2026-04-28)

### Features

* **executor:** pass configured agent provider/model explicitly to runEmbeddedPiAgent ([3a5b1ff](https://github.com/d0labs/aof/commit/3a5b1ffce0e92d78508855364470e195e5f478f6))

### Bug Fixes

* **dispatch:** classify credential errors as permanent so they deadletter on first failure ([2261107](https://github.com/d0labs/aof/commit/22611076998abe2fa814ad9592b3685a71a8f9d3))
* **plugin:** align with OpenClaw plugin contract — registrationMode guard, typed on, reload policy ([8d2cd57](https://github.com/d0labs/aof/commit/8d2cd5759d5269a6eb6a01bcb7957c853da41b04)), closes [#2](https://github.com/d0labs/aof/issues/2) [#3](https://github.com/d0labs/aof/issues/3) [#2](https://github.com/d0labs/aof/issues/2) [#3](https://github.com/d0labs/aof/issues/3) [#1](https://github.com/d0labs/aof/issues/1)
* **plugin:** register spawn-poller and chat-delivery-poller as plugin services ([99adb1f](https://github.com/d0labs/aof/commit/99adb1feda57a4f1c76d8eb75843185982343b1d)), closes [#1](https://github.com/d0labs/aof/issues/1) [#2](https://github.com/d0labs/aof/issues/2) [#3](https://github.com/d0labs/aof/issues/3)

### Tests

* **views:** retry-on-flake for ViewWatcher chokidar tests ([21ba14b](https://github.com/d0labs/aof/commit/21ba14b1c710f7386001b40f305cc5d072873f14))

## [1.17.4](https://github.com/d0labs/aof/compare/v1.17.3...v1.17.4) (2026-04-26)

### Features

* **TASK-2026-04-26-LvehGFbK:** implement artifact lifecycle v1 ([9bad57f](https://github.com/d0labs/aof/commit/9bad57faf329390185407c3f2d00969a528c8567))

### Refactor

* remove project.participants — dead config, no consumer ([6bd2b5e](https://github.com/d0labs/aof/commit/6bd2b5eb55cc7c704ab110888ced04be56b0c251))

## [1.17.3](https://github.com/d0labs/aof/compare/v1.17.2...v1.17.3) (2026-04-26)

### Bug Fixes

* **dispatch:** auto-include missing agent in project participants instead of blocking ([d8f1046](https://github.com/d0labs/aof/commit/d8f1046fb9db860b6e17c7275036721d8f5ac03e))
* **store:** replace per-store task ID counter with nanoid suffix to prevent cross-store collisions ([fbcdda8](https://github.com/d0labs/aof/commit/fbcdda8944d64882d239c66c42cfb2360de168ec))

## [1.17.2](https://github.com/d0labs/aof/compare/v1.17.1...v1.17.2) (2026-04-26)

### Features

* **999.3-01:** guard handleStaleHeartbeat against stale-status + lease-reassignment races ([54c7b04](https://github.com/d0labs/aof/commit/54c7b04268a5df3c8824118817cc83e3b0ae10b8))

### Tests

* **999.3-01:** per-precondition coverage for handleStaleHeartbeat guards ([a740adb](https://github.com/d0labs/aof/commit/a740adb814cec5befeb301fd29b548fb0138b1fa))
* **999.3-01:** RED stale_heartbeat precondition incident regression ([c93f6ea](https://github.com/d0labs/aof/commit/c93f6ea601f9a4369c28ffffca6039436b712684))

## [1.17.1](https://github.com/d0labs/aof/compare/v1.17.0...v1.17.1) (2026-04-25)

### Features

* **46-01:** extend TransitionOpts.metadataPatch for atomic stamp+rename ([7de2633](https://github.com/d0labs/aof/commit/7de2633874e096853808e3756f62bf5ab5b7be99)), closes [#1](https://github.com/d0labs/aof/issues/1) [#2](https://github.com/d0labs/aof/issues/2) [#3](https://github.com/d0labs/aof/issues/3) [#1](https://github.com/d0labs/aof/issues/1)

### Bug Fixes

* **46-01:** address checker SUGGESTION — vi.mock for named imports ([21cdb93](https://github.com/d0labs/aof/commit/21cdb9344f182a6687964107642ac905d4baf36d))
* **46-01:** collapse transitionToDeadletter to single atomic store.transition call (BUG-046a) ([a5546d7](https://github.com/d0labs/aof/commit/a5546d70f7981cadad47b9a7a96d922a5e3eae64))
* **46-02:** add startup reconciliation pass to FilesystemTaskStore.init() (BUG-046a) ([ab6f4bd](https://github.com/d0labs/aof/commit/ab6f4bd7994995bd6c261a0f54afd106eb8313a8))
* **46-02:** address checker BLOCKER + WARNINGs — Q3 deferral, T-46-02-05, wave flatten ([d141e11](https://github.com/d0labs/aof/commit/d141e115efce0a7fc1af3f5960952174dcb97dd6))
* **46-03:** address checker WARNING — flatten wave to enable parallel exec ([92f6d62](https://github.com/d0labs/aof/commit/92f6d627ff91857e4b379324b2daddf5aeeb3ac1))
* **46-03:** rediscover projects on each poll to catch post-init creations (BUG-046b) ([769c4bf](https://github.com/d0labs/aof/commit/769c4bf954d381f7320eb63f47302fe04bdca79e))
* **46-04:** address checker WARNINGs + SUGGESTION — logger test strategy, fatal log follow-up ([f8b711c](https://github.com/d0labs/aof/commit/f8b711c621ab225d38e65b48206fe0a81e8198f3))
* **46-04:** skip pino-roll worker transport in vitest env ([c643c24](https://github.com/d0labs/aof/commit/c643c24b5d735a471d1a8c5bbf0440d7740f2a90))
* **46-04:** wire pino-roll transport, drop fd:2 destination (BUG-046c) ([60c4a9d](https://github.com/d0labs/aof/commit/60c4a9dfba6a441b065a1e36e09bf177f37538e3))
* **46-05:** address checker WARNING — flatten wave to enable parallel exec ([b06f5f8](https://github.com/d0labs/aof/commit/b06f5f893bd921d20b7412c011c1083815c4a9f2))
* **46-05:** reject empty-routing at aof_dispatch; default from project owner (BUG-046d) ([30fdf2d](https://github.com/d0labs/aof/commit/30fdf2da0dcf34b31cdd76116696fad5cae42804))
* **46-06:** address checker WARNING + SUGGESTION — reorder rationale, complete StoredRecipient mock ([45a8283](https://github.com/d0labs/aof/commit/45a82839075efa0951a58cee8111a1a4bec1657d))
* **46-06:** inject envelope actor into inner.data at /v1/tool/invoke (BUG-046e) ([b17a153](https://github.com/d0labs/aof/commit/b17a153f0c173aa30ff708abc1d68c3d2f9e5a42))
* **46-06:** plugin-side defense-in-depth actor fallback from captured.actor (BUG-046e) ([f96d27c](https://github.com/d0labs/aof/commit/f96d27c852715ca0a1052063d4e79fbc77141caf))
* **46:** mark RESEARCH Open Questions RESOLVED — Dimension 11 gate ([a39aa83](https://github.com/d0labs/aof/commit/a39aa832b3e1b1b5e2ad5699ec3834cda9a554e9))

### Tests

* **46-01:** add RED regression for atomic transitionToDeadletter (BUG-046a) ([8db8a7c](https://github.com/d0labs/aof/commit/8db8a7c25fc1943999275a373bc50975dc1fbc82))
* **46-02:** add RED regression for startup reconciliation (BUG-046a) ([160d493](https://github.com/d0labs/aof/commit/160d493cb31765fbffa829b257cbb1bcc8773a40))
* **46-03:** add RED integration test for post-init project rediscovery (BUG-046b) ([46757d6](https://github.com/d0labs/aof/commit/46757d62629dc3f93382fdc6a8f237a4b5a61ce2))
* **46-04:** add RED config-sniff regression for pino-roll wiring (BUG-046c) ([23ee0e3](https://github.com/d0labs/aof/commit/23ee0e3b1328b04ede71d8dc5e5f88a2719caf54))
* **46-05:** add RED regression for aof_dispatch routing validation (BUG-046d) ([edd35f6](https://github.com/d0labs/aof/commit/edd35f6e1a67c0d56e500d34361c0ed365de193a))
* **46-06:** add RED regression for envelope + plugin actor propagation (BUG-046e) ([fa7bae4](https://github.com/d0labs/aof/commit/fa7bae4bb82ec4149df3518d463bca55739e2d71))

## [1.17.0](https://github.com/d0labs/aof/compare/v1.16.3...v1.17.0) (2026-04-25)

### Features

* **44-03:** enrich mergeDispatchNotificationRecipient with dispatcher identity ([cca9e0e](https://github.com/d0labs/aof/commit/cca9e0eddb65455d267dfd2081cce8c49df208b0))
* **44-03:** promote OpenClawChatDelivery to a first-class Zod schema ([3bc842a](https://github.com/d0labs/aof/commit/3bc842ac3562ad15f1cfbf742b0b1a456f82a917))
* **44-04:** disable default wall-clock TTL on OpenClawToolInvocationContextStore ([c77aee6](https://github.com/d0labs/aof/commit/c77aee6cb324bda2da5f6e19b6c8317d7a375e72))
* **44-05:** bound chat-delivery queue with 60s default ack timeout ([f4abaa4](https://github.com/d0labs/aof/commit/f4abaa4e3d47c39fb64fe89d0565282762792962))
* **44-06:** introduce NoPlatformError in chat-message-sender ([fcafdb3](https://github.com/d0labs/aof/commit/fcafdb323e0742d5b0419f34ad86b861ed66954a))
* **44-06:** record agent-callback-fallback attempt for no-platform errors ([999e7f1](https://github.com/d0labs/aof/commit/999e7f120023fbee29b4043411f39ac031a2aa43))
* **44-07:** add replayUnnotifiedTerminals + wake-up.* telemetry ([3210b51](https://github.com/d0labs/aof/commit/3210b515c0f9a4d379738a10ba3c83b4312d01aa))
* **44-07:** wire replayUnnotifiedTerminals into daemon bootstrap ([bde9e15](https://github.com/d0labs/aof/commit/bde9e15c762d898d58c6d143908e9a98ad70ad3a))

### Bug Fixes

* **44-01:** WR-01+WR-02 serialize wake-up replay before attaching live listener ([04dd8b7](https://github.com/d0labs/aof/commit/04dd8b75788ff028e4a051a4e644392e2276dc8e))
* **44-02:** WR-03 anchor parseSessionKey topic suffix to index 5 ([43d65a4](https://github.com/d0labs/aof/commit/43d65a423adbccc29d46783c18fc6f98d588f1d2))
* **45:** revise plans based on checker feedback (Blockers [#1](https://github.com/d0labs/aof/issues/1)-2 + Warnings [#3](https://github.com/d0labs/aof/issues/3)-7 + Suggestions [#8](https://github.com/d0labs/aof/issues/8)-10) ([f1f1c1d](https://github.com/d0labs/aof/commit/f1f1c1deb97b4bcff4a4b889275539db0281181d)), closes [#1-2](https://github.com/d0labs/aof/issues/1-2) [#3-7](https://github.com/d0labs/aof/issues/3-7) [#8-10](https://github.com/d0labs/aof/issues/8-10) [#2](https://github.com/d0labs/aof/issues/2) [#4](https://github.com/d0labs/aof/issues/4) [#5](https://github.com/d0labs/aof/issues/5) [#6](https://github.com/d0labs/aof/issues/6) [#7](https://github.com/d0labs/aof/issues/7) [#8-10](https://github.com/d0labs/aof/issues/8-10)
* **dispatch:** create task directly in ready/, skip backlog intermediate ([0ab4001](https://github.com/d0labs/aof/commit/0ab4001eb9178542a965dd99a36e45b38584fbc1))
* **dispatch:** stamp deadletter cause into task frontmatter + document superseded cancel path ([1a90da1](https://github.com/d0labs/aof/commit/1a90da181ec6d3540f016a93d7e1d960fc4d42ed))
* **dispatch:** validate dependsOn IDs against store at dispatch time ([5340610](https://github.com/d0labs/aof/commit/5340610e2d9e3c3392f9b035de1ec706cbcd648e))
* **openclaw:** pass auth: \"gateway\" on registerHttpRoute calls ([c683c71](https://github.com/d0labs/aof/commit/c683c71fb06721eca4cbffecd4d2a50d805b8999))
* **store:** guard addDep/removeDep/update/updateBody with per-task lock ([94e794d](https://github.com/d0labs/aof/commit/94e794d2344f5a6c3e310ca2ded4b181337e3ba2))
* **tools:** aof_task_dep_remove tolerates nonexistent blocker IDs ([00cd869](https://github.com/d0labs/aof/commit/00cd869e4201211cd825a4078b5ae3d76ba1c778))

### Refactor

* **44-03:** replace local OpenClawChatDelivery interface with Zod-inferred type ([dd50362](https://github.com/d0labs/aof/commit/dd50362f181fb2e55a52509bb55df34d230b93e3))

### Tests

* **44-01:** add Phase 44 RED test for default-TTL removal ([c18a12c](https://github.com/d0labs/aof/commit/c18a12c6282cc1413ef7ff7e35d2b064f3b6ad44))
* **44-01:** add Phase 44 RED tests for ChatDeliveryQueue timeout ([695f3e0](https://github.com/d0labs/aof/commit/695f3e081facdd6cc7eb41ab106826de05d233f9))
* **44-01:** add Phase 44 RED tests for dispatch-notification identity enrichment ([9f7dd33](https://github.com/d0labs/aof/commit/9f7dd33bcae71840ca87063adae85437eb42b1bb))
* **44-02:** add RED integration test for dispatcher wake-up E2E ([8720547](https://github.com/d0labs/aof/commit/872054765a2b656f9e89a404e7bbb73afcc3c097))
* **44-02:** add RED test for notifier-startup recovery pass ([8cc9dfb](https://github.com/d0labs/aof/commit/8cc9dfb19c68c4270b1643d46fc2bf0154c92254))
* **44-02:** add RED test for subagent-sessionKey agent-callback-fallback ([9396dd6](https://github.com/d0labs/aof/commit/9396dd6188ac0280c838524dfde4b7cd593354e0))

## [1.16.3](https://github.com/d0labs/aof/compare/v1.16.2...v1.16.3) (2026-04-23)

### Bug Fixes

* **store:** harden transitionTask against partial-rename split-state ([6fbcb18](https://github.com/d0labs/aof/commit/6fbcb18cf187c7cf770e9468edcf2a7e4d9eec0a))

## [1.16.2](https://github.com/d0labs/aof/compare/v1.16.1...v1.16.2) (2026-04-23)

### Bug Fixes

* **scheduler:** poll root store alongside project stores in multi-project mode ([193a242](https://github.com/d0labs/aof/commit/193a242cb16c7111a277bced5217b2f7ba76a2ae))

## [1.16.1](https://github.com/d0labs/aof/compare/v1.16.0...v1.16.1) (2026-04-23)

### Features

* **subscription:** add attempts audit trail; clear stale failureReason ([b71947a](https://github.com/d0labs/aof/commit/b71947a703b23a53488f06397bd3211a68018e86))

### Bug Fixes

* **chat-delivery:** migrate sender to unified runtime.channel.outbound API ([711d91e](https://github.com/d0labs/aof/commit/711d91e4be395ebf02849f32ffe6e56015477132))
* **daemon:** default mode to plugin-bridge; document zombie-agent cache ([2e58395](https://github.com/d0labs/aof/commit/2e583951d44f7bfafe13c34e40b3448586f96cff))
* **daemon:** pass vaultRoot to AOFService for multi-project discovery ([ee63dc0](https://github.com/d0labs/aof/commit/ee63dc06aeac357193f9ec81a97c33c3475e4544))

## [1.16.0](https://github.com/d0labs/aof/compare/v1.15.1...v1.16.0) (2026-04-23)

### Features

* **chat-delivery:** wire completion notifications from daemon to OpenClaw sessions ([1b34b18](https://github.com/d0labs/aof/commit/1b34b185009de84658e8f96df44ce4525939be6f))

## [1.15.1](https://github.com/d0labs/aof/compare/v1.15.0...v1.15.1) (2026-04-18)

### Features

* **migrations:** add 008-strip-bogus-project-data to clean tainted tasks ([b1014f2](https://github.com/d0labs/aof/commit/b1014f20a50b184955ea17aa749f992753a0e617))

### Bug Fixes

* **daemon,service,mcp:** pass explicit null projectId for root store ([1389667](https://github.com/d0labs/aof/commit/138966777d70d8c6e13f3a8c8dc7c336ae241bdf))
* **store:** remove basename() projectId fallback, make unscoped explicit ([4297713](https://github.com/d0labs/aof/commit/4297713cd97867797edba1b88946beeb971a6d6c))
* **test-infra:** bound HTTP timeout in StandaloneAdapter fall-through test ([203bb3c](https://github.com/d0labs/aof/commit/203bb3c862259ffa2503e9bdc2f815c6312e3e20))
* **test-infra:** raise HNSW P99 ceiling to regression-guard (not benchmark) ([c3741e4](https://github.com/d0labs/aof/commit/c3741e44d304d6de218bacc2060d3472e7b83016))
* **test-infra:** scope default vitest config to src/__tests__ only ([b9d9196](https://github.com/d0labs/aof/commit/b9d919684a405dc1962eb00b7156b30cb3eeb293))
* **test-infra:** widen vi.waitFor timeout for daemon SIGTERM cleanup tests ([4bf55e1](https://github.com/d0labs/aof/commit/4bf55e18b761b9311e57f57fd5ba60f31c2e9388))

### Tests

* **044:** RED — assert no project leak from unscoped store ([c3b63b5](https://github.com/d0labs/aof/commit/c3b63b549ec2837c3fbcece282f4062b66b0165d))

## [1.15.0](https://github.com/d0labs/aof/compare/v1.14.11...v1.15.0) (2026-04-18)

### Features

* **43-03:** IPC envelope schemas + daemon.mode config flag (D-05/D-06/D-07/D-13) ([d99d494](https://github.com/d0labs/aof/commit/d99d49499f7d69206625da88cb6b16621400a20c))
* **43-03:** IPC routes invoke-tool + session-events + server-attach + store-resolver ([598db40](https://github.com/d0labs/aof/commit/598db400da3f425438c007588db57c0231e7e255))
* **43-03:** wire attachIpcRoutes into startAofDaemon (D-05 routes live on daemon.sock) ([ebe4d76](https://github.com/d0labs/aof/commit/ebe4d76d2825b0aec70d6fe6243b256e55918138))
* **43-04:** long-poll spawn queue + plugin registry + wait/result routes (D-09/D-11) ([672be1c](https://github.com/d0labs/aof/commit/672be1ce23006b1861b3ac1a50b65b682fc6d063))
* **43-04:** PluginBridgeAdapter + SelectingAdapter (D-10) ([96139df](https://github.com/d0labs/aof/commit/96139dfc536494fe5afd69d3935648afadd97a0f))
* **43-05:** hold-in-ready branch for no-plugin-attached dispatch (D-12) ([45b3f63](https://github.com/d0labs/aof/commit/45b3f63f06967f624c52612e1a453b1f79a1e7f2))
* **43-05:** wire SelectingAdapter + SpawnQueue + PluginRegistry into startAofDaemon (D-10/D-12) ([f7b4529](https://github.com/d0labs/aof/commit/f7b45295a37c3fce678f4e972619eedf0ec953d6))
* **43-06:** DaemonIpcClient + module-level singleton (D-05/D-06/D-09) ([1e39708](https://github.com/d0labs/aof/commit/1e397080e874de02d2c7c4589754dd3979064cbc))
* **43-06:** spawn-poller long-poll loop + runAgentFromSpawnRequest refactor (D-09) ([9f9ecd4](https://github.com/d0labs/aof/commit/9f9ecd4d3d184263fb78e362e3987dff6be146e2))
* **43-07:** thin-bridge restructure of src/openclaw/adapter.ts (D-02/D-06/D-07) ([412e776](https://github.com/d0labs/aof/commit/412e776e65c6f91b005cec1dcd38d947578e496b))
* **43-08:** migration 007 — always install aof-daemon (D-14) ([81a8f45](https://github.com/d0labs/aof/commit/81a8f457c0c13bc8d6e9dd3148e9066bd6620279))
* **43-08:** reverse Phase 42 installer gates, demote --force-daemon (D-01/D-04) ([00ffda9](https://github.com/d0labs/aof/commit/00ffda914ff2d3b09a1ff42e52c97796de67acdc))

### Bug Fixes

* **43:** WR-01 short-circuit readBody data handler after limit exceeded ([87d1b29](https://github.com/d0labs/aof/commit/87d1b29d2b9dbe0be6707fa1ee04dbe207cf0f35))
* **43:** WR-02 remove raw-string guard from install.sh dir-equality check ([0c595ff](https://github.com/d0labs/aof/commit/0c595ff02aaaa43a8c34495269f060aa5a5939a1))
* **43:** WR-03 replace as-cast with typed annotation in SpawnQueue.enqueue ([3ef5726](https://github.com/d0labs/aof/commit/3ef5726808c462932367d7637538adf4e9fbe64a))

### Refactor

* **43-07:** move aof_project_* tools into shared tool-registry (Open Q2 resolution) ([9c079d8](https://github.com/d0labs/aof/commit/9c079d87373c0d8fdc2559adc4814ba70e73eda0))

### Tests

* **43-01:** add RED dispatch/plugin/migration scaffolding tests ([55d2cb2](https://github.com/d0labs/aof/commit/55d2cb272a31eaea1ccdd1dee9ded6beee3e7365))
* **43-01:** add RED IPC core scaffolding tests ([dfb8b18](https://github.com/d0labs/aof/commit/dfb8b187ea65a74233bc60f7809556dce3746275))
* **43-02:** add integration helpers daemon-harness + plugin-ipc-client ([29b5671](https://github.com/d0labs/aof/commit/29b5671b3f890f3807caf0dc39f84ccfdfb67841))
* **43-02:** add RED integration scaffolds for IPC round-trip, long-poll, hold, restart, session boundaries ([f83950e](https://github.com/d0labs/aof/commit/f83950e21310dc6ea1c37d3cf6e3565fb34d8bef))
* **43-06:** RED — spawn-poller idempotency, keepalive, backoff, exception posting ([f6c95ef](https://github.com/d0labs/aof/commit/f6c95efafc29efb9908a8e85fb3ab7972a064d8d))
* **43:** persist human verification items as UAT ([d3e03d8](https://github.com/d0labs/aof/commit/d3e03d8df9c8b8e042f430262028491cdb064cd5))

## [1.14.11](https://github.com/d0labs/aof/compare/v1.14.10...v1.14.11) (2026-04-17)

### Bug Fixes

* **dispatch:** bump spawnTimeoutMs fallback 30_000 → 300_000 ([8577a4e](https://github.com/d0labs/aof/commit/8577a4e8f70c08da341ebf6dc255ae69699e64cf))
* **dispatch:** DAG hop dispatch forwards per-task timeoutMs ([5349f34](https://github.com/d0labs/aof/commit/5349f34c88fd1bf33dc9c25d41818fbeb103a30e))
* **dispatch:** escalation re-dispatch forwards per-task timeoutMs ([9c92216](https://github.com/d0labs/aof/commit/9c922162fb1253179337308e1f71b9da4b56879e))
* **dispatch:** murmur integration forwards per-task timeoutMs ([6c80130](https://github.com/d0labs/aof/commit/6c801303193e9b3772a4200b06c5683146445480))
* **mcp,dispatch:** aof_dispatch end-to-end timeoutMs via MCP ([41edf2e](https://github.com/d0labs/aof/commit/41edf2e4c03b3e119d5c039b8f17d03e1a9cf275))
* **openclaw:** honor caller-supplied timeout (remove floor clamp) ([2830ce1](https://github.com/d0labs/aof/commit/2830ce1ef9d499829c7cc07e73d69534b2cf172e))

## [1.14.10](https://github.com/d0labs/aof/compare/v1.14.9...v1.14.10) (2026-04-16)

### Bug Fixes

* **store:** self-heal duplicate task files instead of throwing forever ([472cd1e](https://github.com/d0labs/aof/commit/472cd1ed8aa56027e264b47be17b98c76af695a1))

### Tests

* **42:** defer human UAT — integration tests cover, advancing to Phase 43 ([a4af36c](https://github.com/d0labs/aof/commit/a4af36c3266a25597cce7a6029208d913dbf0fca))

## [1.14.7](https://github.com/d0labs/aof/compare/v1.14.6...v1.14.7) (2026-04-15)

### Bug Fixes

* **projects:** auto-bootstrap projects on first store access ([c9aa268](https://github.com/d0labs/aof/commit/c9aa268abe6cad0b1ae77cdb9f4db4873b2497de))

## [1.14.6](https://github.com/d0labs/aof/compare/v1.14.5...v1.14.6) (2026-04-15)

### Bug Fixes

* **updater:** route install/update to code root, not data root ([cb1ff6d](https://github.com/d0labs/aof/commit/cb1ff6d9c1945c8871549cf27dfdf6b6434b2067))

## [1.14.5](https://github.com/d0labs/aof/compare/v1.14.4...v1.14.5) (2026-04-15)

### Bug Fixes

* correct self-update release asset lookup ([724e58b](https://github.com/d0labs/aof/commit/724e58b4cf8550ba14063590e817a9c7e8fce995))

## [1.14.4](https://github.com/d0labs/aof/compare/v1.14.3...v1.14.4) (2026-04-14)

### Features

* **42-02:** add plugin_mode_detected gate to install.sh ([9984a16](https://github.com/d0labs/aof/commit/9984a1676abc414e1dde967f9cd8b548ae231a25))
* **42-03:** add --force-daemon override to installer ([c53e50d](https://github.com/d0labs/aof/commit/c53e50de724e3322444eeee005678c8384294547))
* **42-04:** add D-05 upgrade convergence to installer ([140674c](https://github.com/d0labs/aof/commit/140674c17e04dc3ee2c8e16b3880e735fc47f2cf))

### Bug Fixes

* **42-02:** correct integration test tarball path ([bd81148](https://github.com/d0labs/aof/commit/bd81148eb5f6952e3eaea70a9bc4c951f89e0f3b))
* **42:** guard D-05 success message behind CLI-binary check ([336c52b](https://github.com/d0labs/aof/commit/336c52bbc35b44ace76fc97d29fb753e43156439))
* harden task dispatch and project-scoped lookup ([e88eadf](https://github.com/d0labs/aof/commit/e88eadffaf35782be162a612ad86cc7475c50393))

### Tests

* **42-01:** add RED integration scaffold for install.sh mode-exclusivity ([f9057f8](https://github.com/d0labs/aof/commit/f9057f86dbbee6ea917b2d4a8f426e953d40ac05))
* **42-01:** add uninstallService idempotency coverage ([fc31411](https://github.com/d0labs/aof/commit/fc314115b55a8fdf5587db696c7aaf63b6ae02ab))
* **42:** persist human verification items as UAT ([9614138](https://github.com/d0labs/aof/commit/9614138c2a8b8bcdb23a73805a750876ea8bdf0a))

## [1.14.3](https://github.com/d0labs/aof/compare/v1.14.2...v1.14.3) (2026-04-14)

### Bug Fixes

* **setup:** correct plugin load path + SKILL.md source location ([19b63cf](https://github.com/d0labs/aof/commit/19b63cf0cbd777e7b93eefd53f3f12278ed5a0cb))

## [1.14.2](https://github.com/d0labs/aof/compare/v1.14.1...v1.14.2) (2026-04-14)

### Features

* **installer:** --tarball flag for local-build testing ([f236bf1](https://github.com/d0labs/aof/commit/f236bf169cdefb041a0910e859893e1183f9578e))

### Bug Fixes

* **daemon:** idempotent launchd install via kickstart -k ([b742f70](https://github.com/d0labs/aof/commit/b742f7052f9ba6fc0ec4965eea803233bfdbd2c8))
* **installer:** emit dist-local openclaw.plugin.json in tarball ([3cd7b69](https://github.com/d0labs/aof/commit/3cd7b6928dbb6e48704b9bc3f15e677b862f587d))
* **snapshot:** exclude non-regular files (sockets, FIFOs, devices) ([afeb63e](https://github.com/d0labs/aof/commit/afeb63e71a006cf520769f47fa63c607d779cdb7))

## [1.14.1](https://github.com/d0labs/aof/compare/v1.14.0...v1.14.1) (2026-04-14)

### Bug Fixes

* **installer:** stop running services before preserve-wipe-restore ([7a73d8c](https://github.com/d0labs/aof/commit/7a73d8c06783e8b258a073e6e46a1afae6b2b3cb))

## [1.14.0](https://github.com/d0labs/aof/compare/v1.13.0...v1.14.0) (2026-04-14)

### Features

* **dispatch:** per-task timeoutMs override in aof_dispatch ([207e2f3](https://github.com/d0labs/aof/commit/207e2f396a09f43b715fc54f065657f2a55e6198))

### Bug Fixes

* **openclaw:** capture sessionKey from hook ctx arg ([34e490e](https://github.com/d0labs/aof/commit/34e490e1532a9ee886e6116918c7f4d02169ec23))
* **openclaw:** correct resolveSessionFilePath call signature ([a165a4f](https://github.com/d0labs/aof/commit/a165a4fa2853d61b3940bb5edb55ebd0a6ae623f))
* **openclaw:** spawn via api.runtime.agent.runEmbeddedPiAgent ([1c65ba5](https://github.com/d0labs/aof/commit/1c65ba59f9e018b012b78a78cbd4f961b3402d1e))

## [1.13.0](https://github.com/d0labs/aof/compare/v1.12.0...v1.13.0) (2026-04-14)

### Features

* **install:** segregate user data from code under ~/.aof/data/ ([28d4849](https://github.com/d0labs/aof/commit/28d4849f5dc08409c1bbc2b7bbc8cb8301694a01))

## [1.11.0](https://github.com/d0labs/aof/compare/v1.10.4...v1.11.0) (2026-04-12)

### Features

* unified deploy, scheduler self-start, team routing, model override ([a7329c4](https://github.com/d0labs/aof/commit/a7329c4eb4f4aa2665c68d37b1a635fe706340d6))

## [1.10.4](https://github.com/d0labs/aof/compare/v1.10.3...v1.10.4) (2026-03-20)

### Bug Fixes

* prevent AOF plugin wiring failures on fresh install/update ([598557a](https://github.com/d0labs/aof/commit/598557ad3f067017b44ab956b61622994215d059))

## [1.10.3](https://github.com/d0labs/aof/compare/v1.10.2...v1.10.3) (2026-03-20)

### Bug Fixes

* add version coherence checks to release pipeline ([26bfba6](https://github.com/d0labs/aof/commit/26bfba6522f298a2c72e5b1207b4a175b79d968d))
* **deploy:** rewrite manifest main field for flattened layout ([ccf021b](https://github.com/d0labs/aof/commit/ccf021bf3c2d467de3592a3165cfb525486d770a))

## [1.10.2](https://github.com/d0labs/aof/compare/v1.10.1...v1.10.2) (2026-03-18)

### Features

* wire subscription tools into shared tool registry ([65c583c](https://github.com/d0labs/aof/commit/65c583c7583a8f6053ab87ba4cddeb667c166dde))

## [1.10.1](https://github.com/d0labs/aof/compare/v1.10.0...v1.10.1) (2026-03-16)

### Bug Fixes

* **installer:** add direct JSON fallback when openclaw CLI not in PATH ([310ba5b](https://github.com/d0labs/aof/commit/310ba5b026cd2942fe3270b489f360aa62078113))

## [1.9.1](https://github.com/d0labs/aof/compare/v1.9.0...v1.9.1) (2026-03-12)

### Features

* **34-02:** remove 15 unused MCP output schemas from mcp/tools.ts ([3dc90cf](https://github.com/d0labs/aof/commit/3dc90cf4e4a483565e056b3353ba4360a17d2ef1))
* **34-02:** remove deprecated aliases, commented-out code, and stale references ([b1ae340](https://github.com/d0labs/aof/commit/b1ae3406838b65c2e5ed81df2c4b34fa21ad357f))

### Bug Fixes

* **34:** revise plan based on checker feedback ([8fc6a04](https://github.com/d0labs/aof/commit/8fc6a0420debad9eb9f82bf279b5820e5ecf77e8))
* unify path defaults to ~/.aof and add reconciliation migration ([db47041](https://github.com/d0labs/aof/commit/db47041f32e2b8957f5c94b15bd9f787d1d8ee65))

### Refactor

* **34-01:** delete gate source files and clean import cascades ([97cdc5e](https://github.com/d0labs/aof/commit/97cdc5e5f2f80e63738e52bf888ad7f73301beee))
* **34-01:** inline gate schemas into task.ts and project.ts ([69a2b2d](https://github.com/d0labs/aof/commit/69a2b2d23e213afdf8f92c506066e676539372b7))

## [1.9.0](https://github.com/d0labs/aof/compare/v1.8.0...v1.9.0) (2026-03-12)

### Bug Fixes

* installer UX, path normalization, and scaffold self-healing ([10bbd59](https://github.com/d0labs/aof/commit/10bbd59cdab88ffd1b2c9f664e650aa86c36dc82))

## [1.8.0](https://github.com/d0labs/aof/compare/v1.7.0...v1.8.0) (2026-03-12)

### Features

* **28-01:** implement SubscriptionStore with CRUD and atomic persistence ([bd0d4e9](https://github.com/d0labs/aof/commit/bd0d4e9a5288117b010855578648b67241f7dfce))
* **29-01:** extend aof_dispatch with subscribe-at-dispatch param ([c667194](https://github.com/d0labs/aof/commit/c667194d9d73bd76f1489df4db95d3a462ca1dcc))
* **29-01:** wire SubscriptionStore into MCP context and add subscribe/unsubscribe tools ([40a982e](https://github.com/d0labs/aof/commit/40a982e4f7c5becb69bb2dd421d94b76b604856f))
* **30-01:** extend subscription schema and store with delivery tracking ([26edcff](https://github.com/d0labs/aof/commit/26edcff23fabdbfe910e558073b21764ab0ae444))
* **30-01:** implement callback delivery with retry and prompt builder ([a7ac0d6](https://github.com/d0labs/aof/commit/a7ac0d684f043de2cc3d25f1c73a04c307c408e3))
* **30-02:** add org chart validation to subscribe operations ([a6cd2fa](https://github.com/d0labs/aof/commit/a6cd2fa8ca8d9f060132c65fe07b0ca9a64a5679))
* **30-02:** wire delivery triggers into onRunComplete and scheduler poll ([88d5289](https://github.com/d0labs/aof/commit/88d52890b8046fee3b93c438969fa3ffb7a30b3e))
* **30-03:** wire captureTrace into callback delivery onRunComplete ([a1b307f](https://github.com/d0labs/aof/commit/a1b307f4968ef88c9f9f27483fa7bda8bc9fa103))
* **31-01:** implement all-granularity callback delivery with batched transitions ([2d99c61](https://github.com/d0labs/aof/commit/2d99c614b3a2773cb33cde44a3a389ee58118e46))
* **31-02:** implement callback depth limiting and restart recovery ([9aa20d0](https://github.com/d0labs/aof/commit/9aa20d01ec75289e59b3070a22de5d031da51908))
* **32-01:** document subscription tools and callback behavior in agent guidance ([1430904](https://github.com/d0labs/aof/commit/1430904468a0fce227361eec51b3132af627843c))
* **33-01:** propagate callbackDepth through MCP session boundary ([6b9d0f4](https://github.com/d0labs/aof/commit/6b9d0f413bc68e5bf568ac40abae75c2f42ef7f1))
* **33-01:** wire deliverAllGranularityCallbacks into assign-executor onRunComplete ([b5bf9f3](https://github.com/d0labs/aof/commit/b5bf9f340194988b51aac384523e579af4b28815))

### Bug Fixes

* **28-01:** resolve TypeScript errors in SubscriptionStore.cancel() ([b3b7827](https://github.com/d0labs/aof/commit/b3b78278605a4220cd006c7e10ab3b5c75097681))
* **30-01:** resolve TypeScript errors in callback-delivery and integration tests ([083dd59](https://github.com/d0labs/aof/commit/083dd59a615c0f561553211b5286e6f750497416))
* **30-01:** resolve TypeScript errors in callback-delivery and subscription-store ([95cf449](https://github.com/d0labs/aof/commit/95cf44991192073daa8404dad3d24b66eab46632))

### Tests

* **28-01:** add subscription schema with validation tests ([eca7506](https://github.com/d0labs/aof/commit/eca7506678baf296ea9731d774ec26538712edbb))
* **29-01:** add failing tests for dispatch subscribe-at-dispatch ([d0539f6](https://github.com/d0labs/aof/commit/d0539f65958c04f32de4827e4f1df299c58dd033))
* **29-01:** add failing tests for subscribe/unsubscribe tools ([771ea52](https://github.com/d0labs/aof/commit/771ea52b300a36f6ddb54627991ac25c34e28f13))
* **30-03:** add failing tests for captureTrace in callback delivery ([034b237](https://github.com/d0labs/aof/commit/034b2376b6d160a32d72cd6e06e6bf2421150782))
* **31-01:** add failing tests for all-granularity callback delivery ([22c14d0](https://github.com/d0labs/aof/commit/22c14d0e995249f4535e105712cb2dde83a8a351))
* **31-02:** add failing tests for callback depth limiting and restart recovery ([2f63ac6](https://github.com/d0labs/aof/commit/2f63ac6b1a26c2d7a4ef19a9b5d419951a3b261a))

## [1.7.0](https://github.com/d0labs/aof/compare/v1.6.2...v1.7.0) (2026-03-09)

### Features

* **25-01:** implement DAG hop completion enforcement ([0c4e90c](https://github.com/d0labs/aof/commit/0c4e90caffa65cf1860fe6e4729bb6ac417d06b7))
* **25-01:** implement top-level completion enforcement ([d900b8c](https://github.com/d0labs/aof/commit/d900b8c9cb311c10ba7b4389302de4adb72097ed))
* **25-02:** add completion protocol section to SKILL.md ([f0050a0](https://github.com/d0labs/aof/commit/f0050a0de7fc3876922a7f3963ac59d011422c32))
* **25-02:** enhance formatTaskInstruction with enforcement consequences ([8c696ba](https://github.com/d0labs/aof/commit/8c696ba08ac7ffedb0a852eab2fddee98daedcd2))
* **26-01:** implement no-op detector ([ba9aa7a](https://github.com/d0labs/aof/commit/ba9aa7af50d8c945092fd422c7c15d963fb52346))
* **26-01:** implement trace schema and session parser ([f869fed](https://github.com/d0labs/aof/commit/f869fed3efbf777eafb117615abeb451c3e6a788))
* **26-02:** implement trace writer and add trace event types ([43f9bb4](https://github.com/d0labs/aof/commit/43f9bb41ea59eab349987638edef2d33467b0c70))
* **26-02:** wire captureTrace into onRunComplete callbacks ([02d169b](https://github.com/d0labs/aof/commit/02d169bb62b7e99ba0f5c9a973d359976010c866))
* **27-01:** add trace formatter with TDD ([30bf89d](https://github.com/d0labs/aof/commit/30bf89d741a1b7b424ca7a3d09ecf8b3d023036e))
* **27-01:** add trace reader with TDD ([755f088](https://github.com/d0labs/aof/commit/755f0886699d7353cfdc29fd217311f9f3be2717))
* **27-02:** register trace command in program.ts ([5c3e0de](https://github.com/d0labs/aof/commit/5c3e0de5a2fbfb329fca967f10bd4cffb32d49a7))
* **27-02:** trace CLI command with DAG hop correlation ([b428a44](https://github.com/d0labs/aof/commit/b428a440e60020478e5fd270f8599524be8a32ac))

### Bug Fixes

* **26-01:** resolve TypeScript error in session-parser toolResult handling ([c52879d](https://github.com/d0labs/aof/commit/c52879dbf2ff17a3c45b9c412b1a23c2bbc0ac87))
* **26-02:** resolve TypeScript errors in trace integration hooks ([89937e9](https://github.com/d0labs/aof/commit/89937e92c4b147cd1603d1e015cc93e4a807002a))
* **27-01:** add non-null assertion for regex capture group ([7da82bf](https://github.com/d0labs/aof/commit/7da82bfb258ddf69e3b1fcf64ef92ef30b7812e0))
* **27:** resolve TypeScript strict null check errors in trace modules ([2a71c5f](https://github.com/d0labs/aof/commit/2a71c5f2e7067eb216c998ede99cf33dd12d6e5d))

### Tests

* **25-01:** add failing tests for DAG hop completion enforcement ([63e114d](https://github.com/d0labs/aof/commit/63e114d6cdd768f071fe8d95e550ee77d861d8ec))
* **25-01:** add failing tests for top-level completion enforcement ([cfbfd07](https://github.com/d0labs/aof/commit/cfbfd0769da1f767e2e5264ba2e7dec41d9efb77))
* **25-02:** add failing test for SKILL.md completion protocol content ([adf0713](https://github.com/d0labs/aof/commit/adf0713603d6993e6a4bdfe630c13cf3c3d34bae))
* **25-02:** add failing tests for formatTaskInstruction enforcement ([7497dd7](https://github.com/d0labs/aof/commit/7497dd78d89d7d89e799747cd5f0f7b63285f820))
* **26-01:** add failing tests for no-op detector ([66bd381](https://github.com/d0labs/aof/commit/66bd381eb9648765381588ede6124f07bac7fdf1))
* **26-01:** add failing tests for trace schema and session parser ([8cee2f7](https://github.com/d0labs/aof/commit/8cee2f717dd5efca580189b502751b1587c99e1a))
* **26-02:** add failing tests for trace writer ([e9e85bc](https://github.com/d0labs/aof/commit/e9e85bcc8fb9749014c5ac47e78fc8e1da2a7599))

## [1.6.1](https://github.com/d0labs/aof/compare/v1.6.0...v1.6.1) (2026-03-05)

### Bug Fixes

* change default vault root from ~/Projects/AOF to ~/.aof ([356c744](https://github.com/d0labs/aof/commit/356c744860a24125219391fc9a3c3e03823aaf01))

## [1.6.0](https://github.com/d0labs/aof/compare/v1.5.0...v1.6.0) (2026-03-05)

### Features

* agent tool visibility fix with dispatch fallback completion ([b643183](https://github.com/d0labs/aof/commit/b643183eff1b8e6a5739727670c6ef3b9420d850))

## [1.5.0](https://github.com/d0labs/aof/compare/v1.4.0...v1.5.0) (2026-03-04)

### Features

* consolidate version strings and deploy skill files on setup ([cecce74](https://github.com/d0labs/aof/commit/cecce745239e51df590db984aba876163e64f9ba))

## [1.3.0](https://github.com/d0labs/aof/compare/v1.2...v1.3.0) (2026-03-04)

### Features

* **17-01:** implement snapshot module and schema relaxation ([0071c4a](https://github.com/d0labs/aof/commit/0071c4a9eb904853caa947c5e95bde1778cb01ad))
* **17-01:** wire snapshot wrapper and marker file into setup.ts ([62c40ca](https://github.com/d0labs/aof/commit/62c40ca5f8fe87c8e596b7bb4594d7feaf0019a3))
* **17-02:** implement three v1.3 migration files ([77b5d59](https://github.com/d0labs/aof/commit/77b5d59d96b5c7c4854f03875b59a824108362b2))
* **17-02:** wire three migrations into getAllMigrations() in setup.ts ([d18c391](https://github.com/d0labs/aof/commit/d18c39124fb386b4aa433377dd1c34329e1570d5))
* **18-01:** implement resolveDefaultWorkflow with graceful degradation ([fb21dca](https://github.com/d0labs/aof/commit/fb21dca9be20903f4cbe4c124797a81d48000f88))
* **18-01:** wire --no-workflow option and default workflow precedence ([5f28d4e](https://github.com/d0labs/aof/commit/5f28d4efb114d87a1e3908d8708640d9755de303))
* **19-01:** implement smoke check runner and CLI command ([4e900f7](https://github.com/d0labs/aof/commit/4e900f7b36204adee26a45677b4c1b3408d74b54))
* **19-01:** register smoke command in CLI via system commands ([d9a40c9](https://github.com/d0labs/aof/commit/d9a40c94d26c323b6463925f23fc8d2f072b2af0))
* **19-02:** add tarball verification script for pre-release CI validation ([f91d8ed](https://github.com/d0labs/aof/commit/f91d8ed3e3ce46619ede13e26dd49a5a373d717c))
* **20-01:** add verify-tarball gate to release pipeline ([20af5f9](https://github.com/d0labs/aof/commit/20af5f926dec48b7996516a3b4eb0d6ed3186331))

### Bug Fixes

* **17-03:** add gate-to-DAG migration to getByPrefix() ([2ecb79e](https://github.com/d0labs/aof/commit/2ecb79e63d0e7f2bc33b0082991d0624389fa64e))
* **17-03:** expand installer backup scope to include Projects/ ([a08a324](https://github.com/d0labs/aof/commit/a08a324ddc6136bf9da49ea421ea6bad97e39549))
* **17:** clarify readPackageVersion in Plan 02 interfaces and task action ([6490e34](https://github.com/d0labs/aof/commit/6490e34e3a65bdf22ee14ef0bdf841c9dbcc0132))
* **19-02:** remove unused mkdir import in upgrade-scenarios test ([f30368d](https://github.com/d0labs/aof/commit/f30368dbb5c5f491d633ad9d2b73f2834fdafb81))
* redact gateway token and 1Password vault IDs from INTEGRATIONS.md ([d41e028](https://github.com/d0labs/aof/commit/d41e0286e0600bc315e820efd502191b259448c5))
* revert premature version bump, let release-it manage it ([517c8b1](https://github.com/d0labs/aof/commit/517c8b1d742a9b62b3c4b09d7d8ffff9abcd1b1e))
* update schema version test to match v1.3 relaxation ([4ececb1](https://github.com/d0labs/aof/commit/4ececb1132c761fd4b2739483a5a1236ca5fa9fa))

### Refactor

* remove legacy gate system, complete DAG migration ([8fe46f8](https://github.com/d0labs/aof/commit/8fe46f8ea5c871a16832bc875444060537375e35))

### Tests

* **17-01:** add failing tests for snapshot create/restore/prune ([013a3c2](https://github.com/d0labs/aof/commit/013a3c2d8aa1d2bdcbd94053a29774a646709596))
* **17-02:** add failing tests for three migration implementations ([8841e65](https://github.com/d0labs/aof/commit/8841e65333e690b36b3155b5f7260df408b1dc70))
* **18-01:** add failing tests for resolveDefaultWorkflow ([ab6a7d2](https://github.com/d0labs/aof/commit/ab6a7d285a6f1ab7fca0625af47b37630dc77293))
* **19-01:** add failing tests for smoke check runner ([91e79b1](https://github.com/d0labs/aof/commit/91e79b1a149e3d21f817a0baebb2f068f9e9cff5))
* **19-02:** add upgrade scenario test suite with four migration path fixtures ([1224078](https://github.com/d0labs/aof/commit/12240782359b4008867debbde5530f3ff4722272))

### Documentation

* **17-01:** complete migration foundation plan ([8d74d59](https://github.com/d0labs/aof/commit/8d74d59c414bc7b8b54f78cb9221ab8aa0de08a9))
* **17-02:** complete migration implementations plan ([1a45218](https://github.com/d0labs/aof/commit/1a45218b8a722f1b95a54bb044ae1acb687e26b1))
* **17-03:** complete bug fixes plan ([2d9ab71](https://github.com/d0labs/aof/commit/2d9ab7160a2bc8b34b373a9120bc9054b1401c41))
* **17:** capture phase context ([8616cd7](https://github.com/d0labs/aof/commit/8616cd7bd63f1da043ea1c316a6f2d71ff543280))
* **17:** create phase plan ([64d38d9](https://github.com/d0labs/aof/commit/64d38d93131f0bd5ca1a89bd7ea27702debe1fc5))
* **17:** research phase domain — migration framework, snapshots, YAML round-trips ([768aee1](https://github.com/d0labs/aof/commit/768aee19292e4050ea727629505c50fa91419a1c))
* **18-01:** complete default workflow auto-attachment plan ([5f7e30e](https://github.com/d0labs/aof/commit/5f7e30e0985b54f978f67e7257cd5430c1368e69))
* **18:** capture phase context ([ee15bb3](https://github.com/d0labs/aof/commit/ee15bb32a3c927ef5a50214c72406257fa96e6f2))
* **18:** create phase plan ([e18e0f2](https://github.com/d0labs/aof/commit/e18e0f25f16084dddedfe00d5a53a5c4e68ebe44))
* **18:** research phase domain -- Commander patterns, default workflow resolution ([8c8afa4](https://github.com/d0labs/aof/commit/8c8afa4815c3fe35f9fb64d67703096aefb675f2))
* **19-01:** complete smoke check CLI command plan ([252f997](https://github.com/d0labs/aof/commit/252f997555ba130ce93b68fdf2963164e00c096a))
* **19-02:** complete upgrade scenarios & tarball verification plan ([aaa4c77](https://github.com/d0labs/aof/commit/aaa4c77bc5e0d02ae7c114e9e43c0a9b7e28cbd2))
* **19:** capture phase context ([bb4c32a](https://github.com/d0labs/aof/commit/bb4c32ae2892183cf7be954c68e85577ed682ce9))
* **19:** create phase plan ([a11acbd](https://github.com/d0labs/aof/commit/a11acbd9645d4692a76b1b2639e8f2055e731d99))
* **19:** research phase domain ([be1830c](https://github.com/d0labs/aof/commit/be1830c27ba60973f68a8a90ef74fd82cea8ade5))
* **20-01:** complete release pipeline and documentation plan ([6fd0555](https://github.com/d0labs/aof/commit/6fd05556c366017d39b8091bc3ed0797d221b40c))
* **20-01:** write UPGRADING.md for v1.3 ([2bb1e1f](https://github.com/d0labs/aof/commit/2bb1e1fc82cd4e15a7ad2ba53600c54d49c14616))
* **20:** capture phase context ([f8c5655](https://github.com/d0labs/aof/commit/f8c5655ceebba6f4230db1dfc4f54ab357e7fe11))
* **20:** create phase plan ([fabc9c1](https://github.com/d0labs/aof/commit/fabc9c1a40c5350bf6b52ce61f34ae53aa41e3b5))
* **20:** research phase domain -- release pipeline, UPGRADING.md, release cut ([33c6696](https://github.com/d0labs/aof/commit/33c6696d654afda9e68ce6085a3b20a6b234046e))
* complete v1.3 project research — stack, features, architecture, pitfalls, summary ([f4a79b7](https://github.com/d0labs/aof/commit/f4a79b7d8500ddd16fa83ed7cc1dc8f05cbbf871))
* create milestone v1.3 roadmap (4 phases) ([b8eec10](https://github.com/d0labs/aof/commit/b8eec10fbd7e042d6a5f17c3bb0edb9089944194))
* define milestone v1.3 requirements ([ff0df13](https://github.com/d0labs/aof/commit/ff0df131ee9538a9a4d4392e47dd238ca1090296))
* **phase-17:** complete phase execution ([9708edd](https://github.com/d0labs/aof/commit/9708eddb81480e3240e3c59c3d9797f92f7fc238))
* **phase-18:** complete phase execution ([d3603c9](https://github.com/d0labs/aof/commit/d3603c96544af12179dff48d839d17121c99742f))
* **phase-19:** complete phase execution ([d09f5c9](https://github.com/d0labs/aof/commit/d09f5c95787f2bd0ef7f9361e7857b08fac1b31f))
* rewrite README intro and clean up formatting ([afa96f6](https://github.com/d0labs/aof/commit/afa96f65e36ea76f5eca82fc27f4bb214710f1a8))
* start milestone v1.3 Seamless Upgrade ([491d6e8](https://github.com/d0labs/aof/commit/491d6e85311dc0b71957c974837a5db7f18c7138))
* **state:** record phase 17 context session ([0feda8b](https://github.com/d0labs/aof/commit/0feda8bfc50da3c92fc30aa0de2f9c277317e66e))
* **state:** record phase 18 context session ([604ae1b](https://github.com/d0labs/aof/commit/604ae1b2d1fd63911782401aebb3f00254e47f88))
* **state:** record phase 19 context session ([c9fa1d4](https://github.com/d0labs/aof/commit/c9fa1d4349f4235fbbf0b42195bd55250f709fbb))
* **state:** record phase 20 context session ([53b0261](https://github.com/d0labs/aof/commit/53b026179674cb99ba7840bf3a572dc162864c06))
