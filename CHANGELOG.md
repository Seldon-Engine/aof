# Changelog

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
