import { describe, it, expect } from './harness.ts'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { delay } from '../src/tools.ts'
import type { JobResult, JobWithMetadata } from '../src/index.ts'

describe('perJobResults', function () {
  it('validates perJobResults must be a boolean', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect((async () => {
      // @ts-expect-error invalid option type
      await ctx.boss.work(ctx.schema, { perJobResults: 'yes' }, async () => [])
    })()).rejects.toThrow('perJobResults must be a boolean')
  })

  it('settles each job in a batch individually with its own output', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const completeId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    const failId = await ctx.boss.send(ctx.schema, { outcome: 'fail' }, { retryLimit: 0 })
    assertTruthy(completeId)
    assertTruthy(failId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => (job.data as { outcome: string }).outcome === 'complete'
        ? { id: job.id, status: 'completed', output: { ok: true } }
        : { id: job.id, status: 'failed', output: new Error('handler said fail') }))

    await spy.waitForJobWithId(completeId, 'completed')
    await spy.waitForJobWithId(failId, 'failed')

    const completed = await ctx.boss.getJobById(ctx.schema, completeId)
    const failed = await ctx.boss.getJobById(ctx.schema, failId)

    assertTruthy(completed)
    expect(completed.state).toBe('completed')
    expect((completed.output as { ok: boolean }).ok).toBe(true)

    assertTruthy(failed)
    expect(failed.state).toBe('failed')
    expect((failed.output as { message: string }).message).toBe('handler said fail')
  })

  it('settles a large batch of distinct per-job outputs', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const size = 25
    const ids: string[] = []
    for (let i = 0; i < size; i++) {
      const id: string | null = await ctx.boss.send(ctx.schema, { n: i }, { retryLimit: 0 })
      assertTruthy(id)
      ids.push(id)
    }

    // Even indices complete with a distinct output, odd indices fail with a distinct output.
    await ctx.boss.work(ctx.schema, { batchSize: size, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => {
        const n = (job.data as { n: number }).n
        return n % 2 === 0
          ? { id: job.id, status: 'completed' as const, output: { n } }
          : { id: job.id, status: 'failed' as const, output: new Error(`failed ${n}`) }
      }))

    for (let i = 0; i < size; i++) {
      await spy.waitForJobWithId(ids[i]!, i % 2 === 0 ? 'completed' : 'failed')
      const job: JobWithMetadata | null = await ctx.boss.getJobById(ctx.schema, ids[i]!)
      assertTruthy(job)
      if (i % 2 === 0) {
        expect(job.state).toBe('completed')
        expect((job.output as { n: number }).n).toBe(i)
      } else {
        expect(job.state).toBe('failed')
        expect((job.output as { message: string }).message).toBe(`failed ${i}`)
      }
    }
  })

  it('fails jobs the handler omits from its results', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const keptId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    const omittedId = await ctx.boss.send(ctx.schema, { outcome: 'omit' }, { retryLimit: 0 })
    assertTruthy(keptId)
    assertTruthy(omittedId)

    // Handler only reports the kept job; the omitted one is left out of the results entirely.
    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs
        .filter(job => (job.data as { outcome: string }).outcome !== 'omit')
        .map(job => ({ id: job.id, status: 'completed' as const })))

    await spy.waitForJobWithId(keptId, 'completed')
    await spy.waitForJobWithId(omittedId, 'failed')

    const kept = await ctx.boss.getJobById(ctx.schema, keptId)
    const omitted = await ctx.boss.getJobById(ctx.schema, omittedId)

    assertTruthy(kept)
    expect(kept.state).toBe('completed')

    assertTruthy(omitted)
    expect(omitted.state).toBe('failed')
    expect((omitted.output as { message: string }).message).toBe('no disposition returned by handler')
  })

  it('fails the whole batch when the handler does not resolve with an array', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 },
      // @ts-expect-error a perJobResults handler must resolve with a JobResult[], not a bare object
      async () => ({ not: 'an array' }))

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect((job.output as { message: string }).message).toContain('must resolve with an array')
  })

  it('still fails the whole batch when the handler throws', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error('boom')
    })

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect((job.output as { message: string }).message).toBe('boom')
  })

  it('retries a per-job failure and can settle it on a later attempt', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { outcome: 'flaky' }, { retryLimit: 1, retryDelay: 0 })
    assertTruthy(jobId)

    // Fail the job on its first processing, complete it on the retry. This exercises the
    // fail -> reinsert-as-retry -> re-fetch -> settle path that retryLimit: 0 tests never reach.
    let attempts = 0
    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => {
        attempts++
        return attempts === 1
          ? { id: job.id, status: 'failed' as const, output: new Error('transient') }
          : { id: job.id, status: 'completed' as const, output: { ok: true } }
      }))

    await spy.waitForJobWithId(jobId, 'failed')
    await spy.waitForJobWithId(jobId, 'completed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('completed')
    expect(job.retryCount).toBe(1)
    expect((job.output as { ok: boolean }).ok).toBe(true)
  })

  it('routes a per-job failure to the dead letter queue with its own output', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => ({ id: job.id, status: 'failed' as const, output: new Error('dlq please') })))

    await spy.waitForJobWithId(jobId, 'failed')

    // The dead letter job carries the original data and the per-job failure output.
    const [dlqJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)
    assertTruthy(dlqJob)
    expect(dlqJob.data.key).toBe('payload')

    const dlqWithMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
    assertTruthy(dlqWithMeta)
    expect((dlqWithMeta.output as { message: string }).message).toBe('dlq please')
  })

  it('unblocks a dependent child when the blocking parent is completed via perJobResults', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true, supervise: true, flowIntervalSeconds: 1, __test__bypass_flow_interval_check: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema, data: { role: 'parent' } },
      { ref: 'child', name: ctx.schema, data: { role: 'child' }, dependsOn: ['parent'] }
    ])
    const parentId = flow.parent
    const childId = flow.child

    const parentBefore = await ctx.boss.getJobById(ctx.schema, parentId)
    assertTruthy(parentBefore)
    expect(parentBefore.blocking).toBe(true)

    // The worker only ever fetches the parent until it completes; unblocking the child is done off
    // the hot path by the background resolver (issue #824), which supervise:true enables here.
    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => ({ id: job.id, status: 'completed' as const, output: { role: (job.data as { role: string }).role } })))

    await spy.waitForJobWithId(parentId, 'completed')
    await spy.waitForJobWithId(childId, 'completed')

    const child = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(child)
    expect(child.blocked).toBe(false)
    expect(child.pendingDependencies).toBe(0)
    expect(child.state).toBe('completed')
  })

  it('fails a job whose result carries an unrecognized status', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      // @ts-expect-error 'skipped' is not a valid JobResultStatus
      jobs.map(job => ({ id: job.id, status: 'skipped', output: { ignored: true } })))

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect((job.output as { message: string }).message).toBe('no disposition returned by handler')
  })

  it('routes a deadletter result straight to the DLQ, bypassing remaining retries', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    // retryLimit is 2, but a deadletter disposition must skip the retries entirely.
    const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 2 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => ({ id: job.id, status: 'deadletter' as const, output: new Error('fatal, do not retry') })))

    await spy.waitForJobWithId(jobId, 'failed')

    // The source job is terminally failed on its first attempt - no retry was consumed.
    const source = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(source)
    expect(source.state).toBe('failed')
    expect(source.retryCount).toBe(0)

    // The dead letter job carries the original data and the per-job output.
    const [dlqJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)
    assertTruthy(dlqJob)
    expect(dlqJob.data.key).toBe('payload')

    const dlqWithMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
    assertTruthy(dlqWithMeta)
    expect((dlqWithMeta.output as { message: string }).message).toBe('fatal, do not retry')
  })

  it('fails a deadletter result terminally when the queue has no DLQ configured', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 5 })
    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
      jobs.map(job => ({ id: job.id, status: 'deadletter' as const, output: new Error('terminal') })))

    await spy.waitForJobWithId(jobId, 'failed')

    // Without a dead letter queue, deadletter is just a terminal failure that skips remaining retries.
    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect(job.retryCount).toBe(0)
    expect((job.output as { message: string }).message).toBe('terminal')
  })

  // The per-job complete/fail paths have a split variant (noMultiMutationCte) that breaks the
  // single multi-mutation CTE into a transaction of separate statements, for backends that reject
  // the CTE (SQLite). The standard coverage run is plain Postgres, so force that variant here
  // with __test__noSkipLockedNoCte (the same toggle the NO_SKIP_LOCKED_NO_CTE=true suite uses) to exercise it.
  describe('split backend path (noMultiMutationCte)', function () {
    it('settles a mixed batch of completions and failures with their own outputs (split path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const completeId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
      const failId = await ctx.boss.send(ctx.schema, { outcome: 'fail' }, { retryLimit: 0 })
      assertTruthy(completeId)
      assertTruthy(failId)

      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
        jobs.map(job => (job.data as { outcome: string }).outcome === 'complete'
          ? { id: job.id, status: 'completed' as const, output: { ok: true } }
          : { id: job.id, status: 'failed' as const, output: new Error('handler said fail') }))

      await spy.waitForJobWithId(completeId, 'completed')
      await spy.waitForJobWithId(failId, 'failed')

      const completed = await ctx.boss.getJobById(ctx.schema, completeId)
      const failed = await ctx.boss.getJobById(ctx.schema, failId)

      assertTruthy(completed)
      expect(completed.state).toBe('completed')
      expect((completed.output as { ok: boolean }).ok).toBe(true)

      assertTruthy(failed)
      expect(failed.state).toBe('failed')
      expect((failed.output as { message: string }).message).toBe('handler said fail')
    })

    it('unblocks a dependent child when the blocking parent is completed', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, __test__enableSpies: true, supervise: true, flowIntervalSeconds: 1, __test__bypass_flow_interval_check: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const flow = await ctx.boss.flow([
        { ref: 'parent', name: ctx.schema, data: { role: 'parent' } },
        { ref: 'child', name: ctx.schema, data: { role: 'child' }, dependsOn: ['parent'] }
      ])
      const parentId = flow.parent
      const childId = flow.child

      const parentBefore = await ctx.boss.getJobById(ctx.schema, parentId)
      assertTruthy(parentBefore)
      expect(parentBefore.blocking).toBe(true)

      // Unblocking the child is done off the hot path by the background resolver (issue #824),
      // which on a noMultiMutationCte backend runs the split decrementDependents + clearBlocking statements.
      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
        jobs.map(job => ({ id: job.id, status: 'completed' as const, output: { role: (job.data as { role: string }).role } })))

      await spy.waitForJobWithId(parentId, 'completed')
      await spy.waitForJobWithId(childId, 'completed')

      const child = await ctx.boss.getJobById(ctx.schema, childId)
      assertTruthy(child)
      expect(child.blocked).toBe(false)
      expect(child.pendingDependencies).toBe(0)
      expect(child.state).toBe('completed')
    })

    it('routes a per-job failure to the dead letter queue with its own output (split path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, noDefault: true, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const deadLetter = `${ctx.schema}_dlq`
      await ctx.boss.createQueue(deadLetter)
      await ctx.boss.createQueue(ctx.schema, { deadLetter })

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
      assertTruthy(jobId)

      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
        jobs.map(job => ({ id: job.id, status: 'failed' as const, output: new Error('dlq please') })))

      await spy.waitForJobWithId(jobId, 'failed')

      // reinsertFailedJobs runs through the split here, carrying the per-id output.
      const [dlqJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)
      assertTruthy(dlqJob)
      expect(dlqJob.data.key).toBe('payload')

      const dlqWithMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
      assertTruthy(dlqWithMeta)
      expect((dlqWithMeta.output as { message: string }).message).toBe('dlq please')
    })

    it('routes a deadletter result straight to the DLQ, bypassing remaining retries (split path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, noDefault: true, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const deadLetter = `${ctx.schema}_dlq`
      await ctx.boss.createQueue(deadLetter)
      await ctx.boss.createQueue(ctx.schema, { deadLetter })

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 2 })
      assertTruthy(jobId)

      // reinsertFailedJobs must force the terminal failure (canRetry = false) so the job dead-letters
      // on its first attempt rather than re-inserting as a retry.
      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
        jobs.map(job => ({ id: job.id, status: 'deadletter' as const, output: new Error('fatal, do not retry') })))

      await spy.waitForJobWithId(jobId, 'failed')

      const source = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(source)
      expect(source.state).toBe('failed')
      expect(source.retryCount).toBe(0)

      const [dlqJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)
      assertTruthy(dlqJob)
      expect(dlqJob.data.key).toBe('payload')

      const dlqWithMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
      assertTruthy(dlqWithMeta)
      expect((dlqWithMeta.output as { message: string }).message).toBe('fatal, do not retry')
    })

    it('no-ops the per-job fail when the job already left the active state', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
      assertTruthy(jobId)

      // Settle the job out of band before returning a failed disposition for it. By the time the
      // split per-job fail runs, selectJobsToFailById finds no active row, so it short-circuits
      // (jobs.length === 0) instead of re-inserting - modelling a job that vanished mid-batch.
      const boss = ctx.boss
      await boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        await boss.complete(ctx.schema, jobs[0]!.id)
        return jobs.map(job => ({ id: job.id, status: 'failed' as const, output: new Error('too late') }))
      })

      // The settle records the (attempted) failure on the spy after the no-op fail runs, so this
      // resolving guarantees the guard executed.
      await spy.waitForJobWithId(jobId, 'failed')

      // The out-of-band completion stands; the per-job fail did nothing.
      const job = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(job)
      expect(job.state).toBe('completed')
    })

    it('completes a job eagerly while another times out (split path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const doneId = await ctx.boss.send(ctx.schema, { role: 'complete' }, { retryLimit: 0, expireInSeconds: 1 })
      const hangId = await ctx.boss.send(ctx.schema, { role: 'hang' }, { retryLimit: 0, expireInSeconds: 1 })
      assertTruthy(doneId)
      assertTruthy(hangId)

      // Settle the fast job eagerly, then hang past the batch's shared expiry. The timeout can only
      // fail the job that was never settled.
      await ctx.boss.work(ctx.schema, { batchSize: 2, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        for (const job of jobs) {
          if ((job.data as { role: string }).role === 'complete') await job.complete({ ok: true })
        }
        for (const job of jobs) {
          if ((job.data as { role: string }).role === 'hang') await delay(3000)
        }
        return []
      })

      await spy.waitForJobWithId(doneId, 'completed')
      await spy.waitForJobWithId(hangId, 'failed')

      const done = await ctx.boss.getJobById(ctx.schema, doneId)
      const hung = await ctx.boss.getJobById(ctx.schema, hangId)

      assertTruthy(done)
      expect(done.state).toBe('completed')
      expect((done.output as { ok: boolean }).ok).toBe(true)

      assertTruthy(hung)
      expect(hung.state).toBe('failed')
      expect((hung.output as { message: string }).message).toContain('handler execution exceeded')
    })

    it('preserves the Error output of an eager fail (split path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: true, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
      assertTruthy(jobId)

      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        for (const job of jobs) await job.fail(new Error('eager boom'))
        return []
      })

      await spy.waitForJobWithId(jobId, 'failed')

      const job = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(job)
      expect(job.state).toBe('failed')
      const output = job.output as { name: string, message: string, stack: string }
      expect(output.message).toBe('eager boom')
      expect(output.name).toBe('Error')
      expect(typeof output.stack).toBe('string')
    })
  })

  // Mirror of the split block above. The standard (multi-mutation CTE) per-job settlement paths
  // - completeJobsWithOutputs / failJobsByIdWithOutputs / deadLetterJobsByIdWithOutputs - only run when
  // noMultiMutationCte is off. The NO_SKIP_LOCKED_NO_CTE=true coverage suite forces it on globally, so without
  // pinning it off here those CTE plans show as uncovered in that run. Force the standard path with
  // __test__noSkipLockedNoCte: false so it is exercised in both the standard and NO_SKIP_LOCKED_NO_CTE coverage runs.
  describe('standard backend path (multiMutationCte)', function () {
    it('settles a mixed batch of completions and failures with their own outputs (standard path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: false, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const completeId = await ctx.boss.send(ctx.schema, { outcome: 'complete' }, { retryLimit: 0 })
      const failId = await ctx.boss.send(ctx.schema, { outcome: 'fail' }, { retryLimit: 0 })
      assertTruthy(completeId)
      assertTruthy(failId)

      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
        jobs.map(job => (job.data as { outcome: string }).outcome === 'complete'
          ? { id: job.id, status: 'completed' as const, output: { ok: true } }
          : { id: job.id, status: 'failed' as const, output: new Error('handler said fail') }))

      await spy.waitForJobWithId(completeId, 'completed')
      await spy.waitForJobWithId(failId, 'failed')

      const completed = await ctx.boss.getJobById(ctx.schema, completeId)
      const failed = await ctx.boss.getJobById(ctx.schema, failId)

      assertTruthy(completed)
      expect(completed.state).toBe('completed')
      expect((completed.output as { ok: boolean }).ok).toBe(true)

      assertTruthy(failed)
      expect(failed.state).toBe('failed')
      expect((failed.output as { message: string }).message).toBe('handler said fail')
    })

    it('routes a deadletter result straight to the DLQ, bypassing remaining retries (standard path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: false, noDefault: true, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const deadLetter = `${ctx.schema}_dlq`
      await ctx.boss.createQueue(deadLetter)
      await ctx.boss.createQueue(ctx.schema, { deadLetter })

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 2 })
      assertTruthy(jobId)

      // deadLetterJobsByIdWithOutputs must force the terminal failure so the job dead-letters on its
      // first attempt rather than re-inserting as a retry, carrying its own per-job output.
      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs =>
        jobs.map(job => ({ id: job.id, status: 'deadletter' as const, output: new Error('fatal, do not retry') })))

      await spy.waitForJobWithId(jobId, 'failed')

      const source = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(source)
      expect(source.state).toBe('failed')
      expect(source.retryCount).toBe(0)

      const [dlqJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)
      assertTruthy(dlqJob)
      expect(dlqJob.data.key).toBe('payload')

      const dlqWithMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
      assertTruthy(dlqWithMeta)
      expect((dlqWithMeta.output as { message: string }).message).toBe('fatal, do not retry')
    })

    it('completes a job eagerly while another times out (standard path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: false, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const doneId = await ctx.boss.send(ctx.schema, { role: 'complete' }, { retryLimit: 0, expireInSeconds: 1 })
      const hangId = await ctx.boss.send(ctx.schema, { role: 'hang' }, { retryLimit: 0, expireInSeconds: 1 })
      assertTruthy(doneId)
      assertTruthy(hangId)

      await ctx.boss.work(ctx.schema, { batchSize: 2, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        for (const job of jobs) {
          if ((job.data as { role: string }).role === 'complete') await job.complete({ ok: true })
        }
        for (const job of jobs) {
          if ((job.data as { role: string }).role === 'hang') await delay(3000)
        }
        return []
      })

      await spy.waitForJobWithId(doneId, 'completed')
      await spy.waitForJobWithId(hangId, 'failed')

      const done = await ctx.boss.getJobById(ctx.schema, doneId)
      const hung = await ctx.boss.getJobById(ctx.schema, hangId)

      assertTruthy(done)
      expect(done.state).toBe('completed')
      expect((done.output as { ok: boolean }).ok).toBe(true)

      assertTruthy(hung)
      expect(hung.state).toBe('failed')
      expect((hung.output as { message: string }).message).toContain('handler execution exceeded')
    })

    it('preserves the Error output of an eager fail (standard path)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noSkipLockedNoCte: false, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
      assertTruthy(jobId)

      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        for (const job of jobs) await job.fail(new Error('eager boom'))
        return []
      })

      await spy.waitForJobWithId(jobId, 'failed')

      const job = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(job)
      expect(job.state).toBe('failed')
      const output = job.output as { name: string, message: string, stack: string }
      expect(output.message).toBe('eager boom')
      expect(output.name).toBe('Error')
      expect(typeof output.stack).toBe('string')
    })
  })

  // Eager per-job settlement: the handler durably settles each job via job.complete()/job.fail() as
  // it finishes, so a batch timeout can only fail jobs that were never settled. These run under the
  // current backend (both split and standard paths are pinned in the blocks above).
  describe('eager settlement (job.complete / job.fail)', function () {
    it('settles some jobs eagerly and the rest via the returned array', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const eagerId = await ctx.boss.send(ctx.schema, { mode: 'eager' }, { retryLimit: 0 })
      const arrayId = await ctx.boss.send(ctx.schema, { mode: 'array' }, { retryLimit: 0 })
      assertTruthy(eagerId)
      assertTruthy(arrayId)

      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        const results: JobResult[] = []
        for (const job of jobs) {
          if ((job.data as { mode: string }).mode === 'eager') {
            await job.complete({ via: 'eager' })
          } else {
            results.push({ id: job.id, status: 'completed', output: { via: 'array' } })
          }
        }
        return results
      })

      await spy.waitForJobWithId(eagerId, 'completed')
      await spy.waitForJobWithId(arrayId, 'completed')

      const eager = await ctx.boss.getJobById(ctx.schema, eagerId)
      const array = await ctx.boss.getJobById(ctx.schema, arrayId)
      assertTruthy(eager)
      assertTruthy(array)
      expect(eager.state).toBe('completed')
      expect((eager.output as { via: string }).via).toBe('eager')
      expect(array.state).toBe('completed')
      expect((array.output as { via: string }).via).toBe('array')
    })

    it('ignores a returned-array entry for an already eagerly-settled job', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
      assertTruthy(jobId)

      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        await jobs[0]!.complete({ via: 'eager' })
        // The array also reports the same job as failed; the eager completion must win.
        return jobs.map(job => ({ id: job.id, status: 'failed' as const, output: new Error('array override') }))
      })

      await spy.waitForJobWithId(jobId, 'completed')

      const job = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(job)
      expect(job.state).toBe('completed')
      expect((job.output as { via: string }).via).toBe('eager')
    })

    it('fails only the unsettled jobs when the handler throws after settling some', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const settledId = await ctx.boss.send(ctx.schema, { role: 'settle' }, { retryLimit: 0 })
      const unsettledId = await ctx.boss.send(ctx.schema, { role: 'throw' }, { retryLimit: 0 })
      assertTruthy(settledId)
      assertTruthy(unsettledId)

      await ctx.boss.work(ctx.schema, { batchSize: 2, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        for (const job of jobs) {
          if ((job.data as { role: string }).role === 'settle') await job.complete({ ok: true })
        }
        throw new Error('handler boom')
      })

      await spy.waitForJobWithId(settledId, 'completed')
      await spy.waitForJobWithId(unsettledId, 'failed')

      const settled = await ctx.boss.getJobById(ctx.schema, settledId)
      const unsettled = await ctx.boss.getJobById(ctx.schema, unsettledId)
      assertTruthy(settled)
      assertTruthy(unsettled)
      expect(settled.state).toBe('completed')
      expect((settled.output as { ok: boolean }).ok).toBe(true)
      expect(unsettled.state).toBe('failed')
      expect((unsettled.output as { message: string }).message).toBe('handler boom')
    })

    it('rejects a second settle of the same job', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
      assertTruthy(jobId)

      const holder: { error: Error | null } = { error: null }
      let markDone = (): void => {}
      const handlerDone = new Promise<void>(resolve => { markDone = resolve })
      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        const job = jobs[0]!
        await job.complete({ ok: true })
        try {
          await job.complete({ ok: false })
        } catch (err) {
          holder.error = err as Error
        }
        markDone()
        return []
      })

      await handlerDone
      assertTruthy(holder.error)
      expect(holder.error.message).toContain('already settled')

      const job = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(job)
      expect(job.state).toBe('completed')
      expect((job.output as { ok: boolean }).ok).toBe(true)
    })

    it('rejects an eager settle after the batch handler finished', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
      assertTruthy(jobId)

      const holder: { settle: (() => Promise<void>) | null } = { settle: null }
      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        const job = jobs[0]!
        holder.settle = () => job.complete({ ok: true })
        return [{ id: job.id, status: 'completed' as const, output: { ok: true } }]
      })

      await spy.waitForJobWithId(jobId, 'completed')
      assertTruthy(holder.settle)
      await expect(holder.settle()).rejects.toThrow('after the batch handler finished')
    })

    it('changes no job state when every job was settled before a handler timeout', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const aId = await ctx.boss.send(ctx.schema, { n: 1 }, { retryLimit: 0, expireInSeconds: 1 })
      const bId = await ctx.boss.send(ctx.schema, { n: 2 }, { retryLimit: 0, expireInSeconds: 1 })
      assertTruthy(aId)
      assertTruthy(bId)

      // Settle both jobs, then hang past expiry. The timeout fires but has nothing unsettled to fail.
      await ctx.boss.work(ctx.schema, { batchSize: 2, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        for (const job of jobs) await job.complete({ n: (job.data as { n: number }).n })
        await delay(3000)
        return []
      })

      await spy.waitForJobWithId(aId, 'completed')
      await spy.waitForJobWithId(bId, 'completed')

      // Let the batch timeout (maxExpiration = 1s) fire, then prove it changed nothing.
      await delay(1500)

      const a = await ctx.boss.getJobById(ctx.schema, aId)
      const b = await ctx.boss.getJobById(ctx.schema, bId)
      assertTruthy(a)
      assertTruthy(b)
      expect(a.state).toBe('completed')
      expect((a.output as { n: number }).n).toBe(1)
      expect(a.retryCount).toBe(0)
      expect(b.state).toBe('completed')
      expect((b.output as { n: number }).n).toBe(2)
      expect(b.retryCount).toBe(0)
    })

    it('retries an eager fail per queue config and settles on the retry', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 1, retryDelay: 0 })
      assertTruthy(jobId)

      let attempts = 0
      await ctx.boss.work(ctx.schema, { batchSize: 10, perJobResults: true, pollingIntervalSeconds: 0.5 }, async jobs => {
        attempts++
        const job = jobs[0]!
        if (attempts === 1) await job.fail(new Error('transient'))
        else await job.complete({ ok: true })
        return []
      })

      await spy.waitForJobWithId(jobId, 'failed')
      await spy.waitForJobWithId(jobId, 'completed')

      const job = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(job)
      expect(job.state).toBe('completed')
      expect(job.retryCount).toBe(1)
      expect((job.output as { ok: boolean }).ok).toBe(true)
    })

    it('attaches no complete/fail to jobs without perJobResults', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
      const spy = ctx.boss.getSpy(ctx.schema)

      const jobId = await ctx.boss.send(ctx.schema, { key: 'payload' }, { retryLimit: 0 })
      assertTruthy(jobId)

      let sawMethods = true
      await ctx.boss.work(ctx.schema, { batchSize: 10, pollingIntervalSeconds: 0.5 }, async jobs => {
        const job = jobs[0]! as { complete?: unknown, fail?: unknown }
        sawMethods = job.complete !== undefined || job.fail !== undefined
      })

      await spy.waitForJobWithId(jobId, 'completed')
      expect(sawMethods).toBe(false)
    })
  })
})
