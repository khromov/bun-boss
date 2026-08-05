# bun-boss internals: a short tour

This document explains how the library is built. It is for a programmer who reads the source for the first time. For usage, read `docs/` instead.

This repo is **bun-boss**, a Bun-first fork of pg-boss. The rename applies to the project only. The npm package is still `pg-boss`, the class is still `PgBoss`, and the Postgres schema is still `pgboss`.

## 1. The one big idea

A job is a row in a Postgres table. Postgres does the locking, not the library. A worker claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED`, so two workers never get the same row. All state lives in one Postgres schema (default `pgboss`): jobs, queues, schedules and archive.

There is no broker and no leader election. Every process runs the same code and competes for rows.

## 2. Composition: `src/index.ts`

`PgBoss` is an `EventEmitter`. It does almost no work. The constructor builds a set of collaborator objects. They all share one `IDatabase` and one resolved config. Public methods delegate, mostly to `Manager`.

```ts
const config = Attorney.getConfig(value)
this.#config = config

const db: (types.IDatabase & { _pgbdb?: false }) | DbDefault = this.getDb()
this.#db = db
...
const contractor = new Contractor(db, config)
const manager = new Manager(db, config)
const boss = new Boss(db, manager, config)

const timekeeper = new Timekeeper(db, manager, config)
manager.timekeeper = timekeeper
```
<sub>`src/index.ts:63-80`, shortened</sub>

Each collaborator is also an `EventEmitter`. `#promoteEvents` re-emits their events on the `PgBoss` instance. This is why a user subscribes to one object only.

```ts
#promoteEvents (emitter: types.EventsMixin) {
  for (const event of Object.values(emitter?.events) as (keyof types.PgBossEventMap)[]) {
    emitter.on(event, arg => this.emit(event, arg))
  }
}
```
<sub>`src/index.ts:105-109`</sub>

The collaborators:

| File | Job |
|---|---|
| `manager.ts` | All job operations: `send`, `fetch`, `work`, `complete`, `fail`, queue CRUD |
| `worker.ts` | The polling loop created by `work()` |
| `boss.ts` | The background supervisor (maintenance) |
| `contractor.ts` | Schema install and migration on `start()` |
| `timekeeper.ts` | Cron scheduling |
| `navigator.ts` | Flow and job-dependency resolver |
| `bam.ts` | Async migration worker for long DDL |
| `notifier.ts` | LISTEN/NOTIFY listener lifecycle |
| `db.ts` | The default `IDatabase`, backed by a `pg.Pool` |

`start()` runs them in order: open the database, migrate the schema, start `manager`, then `notifier`, then `boss` and `navigator`, then `timekeeper`, then `bam`. `stop()` reverses the order.

## 3. All SQL lives in `src/plans.ts`

Plan builders are pure functions. The `schema` name is always the first argument. A builder returns a `string`, or a `{ text, values }` object when it needs bind parameters. Components never write SQL inline. They call a `plans.*` builder and pass the result to `db.executeSql`.

```ts
const { table, policy, notify } = await this.getQueueCache(name)

if (policy === plans.QUEUE_POLICIES.key_strict_fifo && !job.singletonKey) {
  throw new Error(`${plans.QUEUE_POLICIES.key_strict_fifo} queues require a singletonKey`)
}

const sql = plans.insertJobs(this.config.schema, { table, name, returnId: true, notify: this.#notifyEnabled(notify) })

const { rows: try1 } = await db.executeSql(sql, [JSON.stringify([job])])
```
<sub>`src/manager.ts:943-951`</sub>

Note the shape: read the queue metadata cache, build the SQL, execute it. The whole job payload goes over as one JSON parameter. Postgres expands it with `json_to_recordset`.

After any DDL change in `plans.ts`, run `bun run gen:manifest`. CI fails otherwise. See section 11.

## 4. Job states are a Postgres enum, and the order matters

```ts
function createEnumJobState (schema: string) {
  // ENUM definition order is important
  // base type is numeric and first values are less than last values
  return `
    CREATE TYPE ${schema}.job_state AS ENUM (
      '${JOB_STATES.created}',
      '${JOB_STATES.retry}',
      '${JOB_STATES.active}',
      '${JOB_STATES.completed}',
      '${JOB_STATES.cancelled}',
      '${JOB_STATES.failed}'
    )
  `
}
```
<sub>`src/plans.ts:136-149`</sub>

A Postgres enum compares by declaration order. So `state < 'active'` means "not claimed yet". And `state <= 'active'` means "not finished yet". Both comparisons appear in the fetch query and in the partial index predicates. Do not reorder this enum.

The lifecycle is: `created` → `active` → `completed`. A failure goes `active` → `retry` → `active`, or `active` → `failed` when the retry limit is reached. A failure deletes the row and inserts it again. It is not an in-place update.

## 5. The claim query

`plans.fetchNextJob` is the largest builder in the file. One CTE selects candidate rows and locks them. One `UPDATE` then sets them to `active` and returns them.

```ts
return {
  text: `
    WITH
    ${activeGroupCountMapCte}
    ${nextCte}
    ${singletonCte}
    ${groupConcurrencyCtes}
    UPDATE ${schema}.${table} j SET
      state = '${JOB_STATES.active}',
      started_on = now(),
      heartbeat_on = now(),
      retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
    ${updateSource}
    WHERE name = '${name}' AND ${updateMatch}
    ${distributedStateCheck}
    RETURNING j.${includeMetadata ? JOB_COLUMNS_ALL : JOB_COLUMNS_MIN}
  `,
  values: params.values
}
```
<sub>`src/plans.ts:1498-1517`, shortened</sub>

`nextCte` holds the `SELECT ... FOR UPDATE OF j SKIP LOCKED`. The other CTEs are optional. They add the singleton and group-concurrency rules. All of it is one statement, so the library cannot crash between the select and the update.

A partial index matches this predicate exactly: `job_i5` is `(name, start_after) WHERE state < 'active' AND NOT blocked`. Every other job index is also partial and gated on state or policy.

Some backends cannot use `SKIP LOCKED`. Then the query drops the lock clause and adds a re-check of `state < 'active'` in the `WHERE`, so two workers cannot claim the same row.

## 6. Partitioning

The `job` table is `PARTITION BY LIST (name)`. One queue maps to one partition.

`job_common` is the DEFAULT partition. Every queue stores its rows there unless it opts out. A queue created with `partition: true` gets its own table. The table name is `'j'` plus `sha224(queue_name)`, because a queue name can exceed the 63-byte identifier limit. A plpgsql function builds the table, adds only the indexes the queue policy needs, and attaches the partition (`plans.ts:534-620`).

Dropping such a queue drops the table. Reclaim is instant, with no `DELETE`.

`queue_stats` uses a second scheme: `PARTITION BY RANGE (captured_on)`, one partition per day. Retention drops old partitions instead of deleting rows.

## 7. The worker loop

A `Worker` owns no SQL and no database handle. `Manager.work()` injects four closures: `fetch`, `onFetch`, `onError` and `resolveInterval`. The policy lives in the manager, so the loop stays small.

```ts
const resolveInterval = (lastFetchCount: number) => {
  const fullBatch = lastFetchCount >= batchSize
  const burst = fullBatch && (
    (burstWhenReadyExceeds !== undefined && getReadyCount() > burstWhenReadyExceeds) ||
    (burstWhenBatchFull && batchSize > 1)
  )

  if (burst) return 0
  return isNotifyActive() ? notifyInterval : interval
}
```
<sub>`src/manager.ts:653-662`</sub>

The precedence is: burst (`0`) → NOTIFY backstop → base poll. The closure runs on each iteration, so a runtime change to the queue takes effect without a worker restart. Burst mode only stays on while fetches come back full. A short fetch returns the worker to normal polling.

The worker subtracts the iteration duration from the delay (`worker.ts:110`). So the cadence is fixed, not the gap. A residual under 100 ms is skipped.

**NOTIFY is only a latency hint.** It wakes a worker so it runs its normal locking fetch sooner. If the listener cannot start, `notifier.ts` emits a warning and the workers keep polling. Correctness never depends on it.

## 8. The background supervisor

`boss.ts` runs one timer, on `superviseIntervalSeconds`. Each tick it walks the queues in chunks and does the maintenance work:

- Cache the queue counts into the `queue` row.
- Warn when the backlog exceeds the queue threshold.
- Fail jobs that exceeded their expiration.
- Fail jobs whose heartbeat went stale.
- Delete jobs past their retention window.
- Prune orphaned dependency rows, old warnings and old stats.

Four services run on timers: `boss`, `timekeeper`, `navigator` and `bam`. They all share one pattern. Each claims a **cluster-wide cadence gate** with a `trySet*Time` UPDATE — `version.cron_on`, `version.bam_on`, `version.flow_on`, `queue.monitor_on`. Only the process that wins the UPDATE does the work. Again, there is no leader election. Each service also holds a reentrancy flag and checks a `#stopping` flag between steps, so `stop()` drains a tick instead of cutting it short.

`navigator.ts` exists so that job completion stays join-free. Completion writes one row. The navigator later audits completed blocking parents and unblocks their children.

## 9. `IDatabase` is one method

```ts
export interface IDatabase {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  listen?(channel: string, onNotification: (payload: string) => void, onReconnect: () => void): Promise<ListenHandle>;
}
```
<sub>`src/types.ts:19-29`, doc comment removed</sub>

Only `executeSql` is required. `listen` is optional and gates `useListenNotify`. Anything that implements this interface can back pg-boss. This is how a caller creates a job inside an existing application transaction: pass the transaction object as `db` on the send options.

The built-in `Db` carries a flag `_pgbdb: true`. `index.ts` reads that flag to decide whether it owns the connection lifecycle. It never opens or closes a user-supplied adapter.

`src/adapters/` holds two adapters, `fromPglite` and `fromBunSql`. Both use native `$N` placeholders. `fromBunSql` carries workarounds for four Bun behaviors. One example: Bun puts the SQLSTATE on `err.errno` instead of `err.code`, and `manager.ts` keys real behavior on code `23505`. So the adapter promotes the SQLSTATE onto `code`.

## 10. Backend compatibility flags

`attorney.ts` is the validation and normalization layer. All user input stops here, not deeper in. `getConfig` resolves the constructor options. `resolveBackend` then expands the `backend` profile into internal flags.

```ts
const BACKEND_PROFILES: Record<types.BackendProfile, BackendDefinition> = {
  postgres: { kind: 'standard', flags: {} },
  cockroachdb: {
    kind: 'distributed',
    flags: {
      noSkipLocked: true,
      noMultiMutationCte: true,
      noTablePartitioning: true,
      noDeferrableConstraints: true,
      noAdvisoryLocks: true,
      noCoveringIndexes: true,
      noListenNotify: true,
```
<sub>`src/attorney.ts:38-49`</sub>

These flags are not user-configurable. `resolveBackend` writes every flag on every call, so a deployment cannot mix an inconsistent set. The flags thread through `plans.ts`, `manager.ts` and `boss.ts` and select alternate query strategies. When you touch a query, check whether it has a distributed variant.

One trap: distributed backends return integer columns as strings. The code coerces known numeric fields with `Number()`. A bare `>` compares text otherwise, and `"100" > "9"` is false.

## 11. Migrations and schema drift

`package.json` holds the target version under `pgboss.schema`. On `start()`, `contractor.ts` reads the installed version from the `version` table and compares. Migrations live in `migrationStore.ts` as a linked list; each entry points at its `previous` version.

Two processes can start at the same time. Both try to migrate. The library resolves the race in the database:

```ts
export function assertMigration (schema: string, version: number) {
  // raises 'division by zero' if already on desired schema version
  return `SELECT version::int/(version::int-${version}) from ${schema}.version`
}
```
<sub>`src/plans.ts:2566-2569`</sub>

This statement is prepended to every migration, and the whole set runs in one transaction behind an advisory lock. The loser divides by zero. Its transaction fails, and `contractor.ts` treats that specific error as a safe race.

`src/schema.json` is generated, never hand-edited. `scripts/gen-manifest.ts` creates the schema on an in-memory PGlite and reads it back from `pg_catalog`. `drifter.ts` runs the same catalog queries against a live database and reports the differences. That powers `boss.detectSchemaDrift()`.

## 12. Tests

Each test derives its own Postgres schema from `sha1(testFile + testName)` (`test/hooks.ts`). That schema is also the queue namespace. So leaf test names must be unique inside a file. A `globalSetup` (`checkDuplicateTestNames.ts`) rejects duplicates before the suite runs, because a collision shows up as flaky interference and not as a clean failure. A failed test keeps its schema, so you can inspect it.

Use the skip helpers from `testHelper.ts` rather than raw `it`: `itPostgresOnly` for partitioning and exact schema shape, `itPglite` for tests that need a real server.

```
bun run test                        # lint + type-check + manifest check + full suite
bun run test -- test/sendTest.ts    # one file
bun run test:bun                    # whole suite through the Bun SQL adapter
bun run test:pglite                 # in-process WASM Postgres, no server
```

## 13. Where to change things

| Change | File |
|---|---|
| Any SQL or DDL | `src/plans.ts`, then `bun run gen:manifest` |
| Job API behavior | `src/manager.ts` |
| Option validation and defaults | `src/attorney.ts` |
| Background maintenance | `src/boss.ts` |
| A schema upgrade | `src/migrationStore.ts`, then bump `pgboss.schema` in `package.json` |
