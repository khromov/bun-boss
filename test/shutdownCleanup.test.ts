import { describe, it, expect } from './harness.ts'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('graceful shutdown cleanup', function () {
  it('does not query a closed pool when a handler is in flight at the graceful timeout', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const errors: string[] = []
    ctx.boss.on('error', (err: any) => errors.push(err?.message ?? String(err)))

    let handlerStarted = false
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })

    // Handler is still running when the 1s graceful timeout expires. failWip() aborts it, which
    // makes bun-boss issue the job's completion write; the fix joins that cleanup before closing
    // the pool, so the write lands on an open connection instead of throwing.
    const workerId = await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      handlerStarted = true
      resolveStarted()
      await delay(3000)
    })

    await ctx.boss.send(ctx.schema)
    ctx.boss.notifyWorker(workerId)
    await started
    assertTruthy(handlerStarted)

    await ctx.boss.stop({ graceful: true, timeout: 1000 })

    // A late completion/fail write against a closed pool surfaces asynchronously, so give it a beat.
    await delay(500)

    const closedPoolErrors = errors.filter((m) => /not opened|connection is not open|closed/i.test(m))
    expect(closedPoolErrors).toEqual([])
  }, 15000)
})
