import { describe, it, expect } from './harness.ts'
import { ctx } from './hooks.ts'
import { getDb } from './testHelper.ts'
import Contractor from '../src/contractor.ts'
import * as migrationStore from '../src/migrationStore.ts'
import { getConfig } from '../src/attorney.ts'
import * as plans from '../src/plans.ts'
import { qn } from '../src/dialect.ts'
import type { Migration } from '../src/types.ts'

// The built-in chain is empty at the v1 install floor, so the upgrade is driven by a synthetic
// migration injected through the internal __test__migrations hook.
describe('migration', function () {
  it('migrates an out-of-date schema forward and guards against a lost race', async function () {
    const config = getConfig(ctx.bossConfig)
    const db = await getDb()

    try {
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

      await contractor.start()
      expect(await contractor.schemaVersion()).toBe(1)

      // The install DDL landed if selecting the new table does not throw.
      await db.executeSql(`SELECT id FROM ${qn(config, 'migration_probe')}`)

      // Re-running the same climb must be swallowed by assertMigration rather than re-apply the DDL.
      await contractor.migrate(0)
      expect(await contractor.schemaVersion()).toBe(1)
    } finally {
      await db.close()
    }
  })

  it('refuses a chain that does not start at the installed version or has a gap', function () {
    const config = getConfig(ctx.bossConfig)
    const step = (previous: number, version: number): Migration =>
      ({ release: 'test', previous, version, install: ['SELECT 1'] })

    expect(() => migrationStore.migrate(config, 1, [step(2, 3)])).toThrow(/the next step starts at 2/)
    expect(() => migrationStore.migrate(config, 1, [step(1, 2), step(3, 4)])).toThrow(/the next step starts at 3/)
  })
})
