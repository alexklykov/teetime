import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addDays,
  freshness,
  pacificClock,
  searchSchema,
  selectedCourses,
  slotIsVisible,
  slotKey,
} from './tee-times'

test('Pacific date and clock stay correct across midnight and DST', () => {
  assert.deepEqual(pacificClock(new Date('2026-10-15T06:30:00Z')), {
    date: '2026-10-14',
    time: '23:30',
  })
  assert.deepEqual(pacificClock(new Date('2026-11-01T09:30:00Z')), {
    date: '2026-11-01',
    time: '01:30',
  })
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})

test('empty course selection remains empty and unknown slugs are ignored', () => {
  assert.deepEqual(selectedCourses(undefined, ['a', 'b']), ['a', 'b'])
  assert.deepEqual(selectedCourses('', ['a', 'b']), [])
  assert.deepEqual(selectedCourses('a,unknown', ['a', 'b']), ['a'])
  assert.deepEqual(selectedCourses('a,a', ['a', 'b']), ['a'])
})

test('invalid calendar dates and clock values cannot reach the database query', () => {
  assert.equal(searchSchema.safeParse({ date: '2026-02-30' }).success, false)
  assert.equal(searchSchema.safeParse({ from: '25:00' }).success, false)
  assert.equal(searchSchema.safeParse({ holes: '36' }).success, false)
  assert.equal(
    searchSchema.safeParse({ date: '2026-10-14', courses: '' }).success,
    true,
  )
})

test('hide past and sold-out slots while preserving distinct hole counts', () => {
  const now = { date: '2026-10-14', time: '12:00' }
  const row = { time: '12:01', holes: 18, availableSpots: 1 }
  assert.equal(slotIsVisible(row, now.date, now, {}), true)
  assert.equal(
    slotIsVisible({ ...row, time: '12:00' }, now.date, now, {}),
    false,
  )
  assert.equal(slotIsVisible(row, '2026-10-13', now, {}), false)
  assert.equal(
    slotIsVisible({ ...row, availableSpots: 0 }, now.date, now, {}),
    false,
  )
  assert.equal(slotIsVisible(row, now.date, now, { holes: '9' }), false)
  assert.equal(
    slotIsVisible(row, now.date, now, { from: '13:00', to: '11:00' }),
    false,
  )
  assert.notEqual(slotKey(row), slotKey({ ...row, holes: 9 }))
})

test('fresh, failed, stale, and never-checked dates have distinct messages', () => {
  const now = new Date('2026-10-14T19:00:00Z')
  const status = {
    attemptedAt: '2026-10-14T18:45:00Z',
    succeededAt: '2026-10-14T18:45:00Z',
    failed: false,
  }
  assert.equal(freshness(status, now).state, 'fresh')
  assert.equal(freshness({ ...status, failed: true }, now).state, 'failed')
  assert.equal(
    freshness({ ...status, succeededAt: '2026-10-14T16:00:00Z' }, now).state,
    'stale',
  )
  assert.equal(freshness(null, now).state, 'unknown')
})
