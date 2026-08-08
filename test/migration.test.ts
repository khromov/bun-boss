import { describe, it, expect } from './harness.ts'
import { ctx } from './hooks.ts'
import { getDb } from './testHelper.ts'
import Contractor from '../src/contractor.ts'
import { getConfig } from '../src/attorney.ts'
import * as plans from '../src/plans.ts'
import { qn } from '../src/dialect.ts'
import type { Migration } from '../src/types.ts'

// Exercises the restored forward-migration path end to end on whichever backend the runner selects
// (postgres / pglite / sqlite). v1 is the install floor and the built-in chain is empty, so the
// upgrade is driven by a synthetic migration injected through the internal __test__migrations hook.
describe('migration', function () {
  it('migrates an out-of-date schema forward and guards against a lost race', async function () {
    const config = getConfig(ctx.bossConfig)
    const db = await getDb()

    try {
      // Fresh install lands at the current schema version.
      const installed = new Contractor(db, config)
      await installed.start()
      expect(await installed.schemaVersion()).toBe(1)

      // Simulate a database installed before this release.
      await db.executeSql(plans.setVersion(config, 0))

      const migration: Migration = {
        release: 'test',
        version: 1,
        previous: 0,
        install: [`CREATE TABLE ${qn(config, 'migration_probe')} (id integer)`]
      }
      const contractor = new Contractor(db, getConfig({ ...ctx.bossConfig, __test__migrations: [migration] }))

      // start() sees installed(0) < target(1) and climbs the chain.
      await contractor.start()
      expect(await contractor.schemaVersion()).toBe(1)

      // The install DDL landed: selecting from the new table does not throw.
      await db.executeSql(`SELECT id FROM ${qn(config, 'migration_probe')}`)

      // Re-running the same climb after the target was already reached must be swallowed by
      // assertMigration — postgres division-by-zero, sqlite version-PK violation — aborting the
      // whole transaction before any DDL re-applies, rather than throwing or double-applying.
      await contractor.migrate(0)
      expect(await contractor.schemaVersion()).toBe(1)
    } finally {
      await db.close()
    }
  })
})
