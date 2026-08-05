# Changelog

## [0.2.0](https://github.com/khromov/bun-boss/compare/pg-boss-v0.1.0...pg-boss-v0.2.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* **api:** remove pub/sub, key_strict_fifo policy, and localGroupConcurrency
* removes detectSchemaDrift(), getMigrationPlans(), getRollbackPlans(), getBamStatus(), getBamEntries(), isBamWorking(), the `bam` event, the cockroachdb/yugabytedb/citus backend profiles, the persistQueueStats/persistWarnings/queueStatRetentionDays/warningRetentionDays and bamIntervalSeconds options, and getQueueStats() history options (from/to/limit/bucketSeconds/maxDataPoints/aggregate). No in-place upgrade from an existing pg-boss database.

### Features

* **api:** remove pub/sub, key_strict_fifo policy, and localGroupConcurrency ([4c17224](https://github.com/khromov/bun-boss/commit/4c172243e0f09c6f3cc9109924747c88ba7222e3))
* slim to a Postgres/PGlite/SQLite core, drop ops machinery ([8db0707](https://github.com/khromov/bun-boss/commit/8db07079915dd4c8f66f756ef830a87864eaa7ae))
