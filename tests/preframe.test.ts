// Preframe's accounts, projects, people and picture allowance (the PREFRAME section of
// api/paypal.ts), against a database in memory.  npm run test:preframe
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memStore, pf } from './load-preframe.ts'

const NOW = Date.UTC(2026, 9, 15, 12)
const maya = { uid: 'maya1', email: 'maya@example.com', emailVerified: true, name: 'מאיה' }
const roni = { uid: 'roni1', email: 'roni@example.com', emailVerified: true, name: 'רוני' }
const dana = { uid: 'dana1', email: 'dana@example.com', emailVerified: false, name: '' }
const P = 'proj0000a1'

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 0
  } catch (err) {
    if (err instanceof pf.PfRefused) return err.status
    throw err
  }
}

async function withProject() {
  const db = memStore()
  await pf.pfCreateProject(db, maya, { id: P, name: 'הבית שעל הגבעה', type: 'feature' }, NOW)
  await pf.pfTouchUser(db, roni, NOW)
  return db
}

// ---- accounts and the allowance ----

test('remembers an account from its first visit, keeps its name, and writes a visit only when needed', async () => {
  const db = memStore()
  await pf.pfTouchUser(db, maya, NOW)
  await pf.pfTouchUser(db, maya, NOW + 60_000)
  assert.equal(db.commits, 1)
  await pf.pfTouchUser(db, { ...maya, email: 'New@Example.com', name: '' }, NOW + 120_000)
  assert.deepEqual(
    { email: db.dump()['accounts/maya1'].email, name: db.dump()['accounts/maya1'].name },
    { email: 'new@example.com', name: 'מאיה' },
  )
  await pf.pfTouchUser(db, { ...maya, email: 'New@Example.com', name: '' }, NOW + 2 * 3600e3)
  assert.equal(db.commits, 3)
})

test('is free until a subscription is granted, and free again when it ends', async () => {
  const db = memStore()
  await pf.pfTouchUser(db, maya, NOW)
  assert.equal(await pf.pfPlanOf(db, 'maya1', NOW), 'free')
  assert.equal(await pf.pfGrant(db, 'nobody@example.com', 'sub', null, 'admin', NOW), false)
  assert.equal(await pf.pfGrant(db, ' Maya@Example.com ', 'sub', null, 'admin', NOW), true)
  assert.equal(await pf.pfPlanOf(db, 'maya1', NOW), 'sub')
  await pf.pfGrant(db, 'maya@example.com', 'sub', new Date(NOW + 86400e3).toISOString(), 'admin', NOW)
  assert.equal(await pf.pfPlanOf(db, 'maya1', NOW + 3600e3), 'sub')
  assert.equal(await pf.pfPlanOf(db, 'maya1', NOW + 2 * 86400e3), 'free')
  await pf.pfGrant(db, 'maya@example.com', 'free', null, 'admin', NOW)
  assert.equal(await pf.pfPlanOf(db, 'maya1', NOW), 'free')
  assert.equal(Object.keys(db.dump()).filter((p) => p.startsWith('events/')).length, 3)
})

test('takes pictures out of the month up to the allowance, and settles each one once', async () => {
  const db = memStore()
  const taken = []
  for (let i = 0; i < 3; i++) taken.push(await pf.pfTakePicture(db, 'maya1', 3, NOW))
  assert.deepEqual(
    taken.map((t) => [t.ok, t.left, t.month]),
    [
      [true, 2, '2026-10'],
      [true, 1, '2026-10'],
      [true, 0, '2026-10'],
    ],
  )
  assert.equal((await pf.pfTakePicture(db, 'maya1', 3, NOW)).ok, false)
  // One was never made: it goes back. One was: its cost goes in the books, capped.
  await pf.pfSettlePicture(db, 'maya1', '2026-10', taken[0].id, false, 0, NOW)
  await pf.pfSettlePicture(db, 'maya1', '2026-10', taken[1].id, true, 166.5, NOW)
  await pf.pfSettlePicture(db, 'maya1', '2026-10', taken[2].id, true, 9e9, NOW)
  assert.deepEqual(await pf.pfUsageOf(db, 'maya1', '2026-10'), { count: 2, neurons: 166.5 + 20_000 })
  // Settling again, or a reservation nobody made, changes nothing.
  await pf.pfSettlePicture(db, 'maya1', '2026-10', taken[0].id, false, 0, NOW)
  await pf.pfSettlePicture(db, 'maya1', '2026-10', 'madeupreservation', false, 0, NOW)
  assert.equal((await pf.pfUsageOf(db, 'maya1', '2026-10')).count, 2)
  // A plan with no paid pictures never takes one; a new month starts from nothing.
  assert.equal((await pf.pfTakePicture(db, 'maya1', 0, NOW)).ok, false)
  assert.equal((await pf.pfTakePicture(db, 'maya1', 3, Date.UTC(2026, 10, 1))).left, 2)
})

test('never lets two requests at once both take the last picture', async () => {
  const db = memStore()
  const all = await Promise.all(Array.from({ length: 10 }, () => pf.pfTakePicture(db, 'maya1', 4, NOW)))
  assert.equal(all.filter((t) => t.ok).length, 4)
  assert.equal((await pf.pfUsageOf(db, 'maya1', '2026-10')).count, 4)
})

// ---- companies and projects ----

test('gives every account one company of its own, once', async () => {
  const db = memStore()
  const first = await pf.pfArrive(db, maya, NOW)
  assert.deepEqual(await pf.pfArrive(db, maya, NOW + 1000), first)
  assert.equal(first.length, 1)
  assert.deepEqual({ role: first[0].role, name: first[0].name }, { role: 'owner', name: 'ההפקות של מאיה' })
  assert.equal((await pf.pfArrive(db, dana, NOW))[0].name, 'ההפקות שלי')
  // Two first visits at once still make one.
  const twice = memStore()
  await Promise.all([pf.pfArrive(twice, roni, NOW), pf.pfArrive(twice, roni, NOW)])
  assert.equal(Object.keys(twice.dump()).filter((p) => p.startsWith('companies/')).length, 1)
})

test('makes a project with its maker as manager, keeps a proposed id, and refuses a taken one', async () => {
  const db = await withProject()
  assert.equal(await pf.pfRoleIn(db, P, 'maya1'), 'manager')
  assert.equal(await pf.pfRoleIn(db, P, 'roni1'), null)
  assert.equal((await pf.pfDocumentAccess(db, 'maya1', P, null, NOW)).kind, 'project')
  assert.equal(await status(pf.pfCreateProject(db, roni, { id: P, name: 'גנבה', type: 'short' }, NOW)), 409)
  assert.equal(await status(pf.pfCreateProject(db, roni, { name: '  ', type: 'short' }, NOW)), 400)
  assert.equal(await status(pf.pfCreateProject(db, roni, { name: 'x', type: 'opera' }, NOW)), 400)
  assert.equal(await status(pf.pfCreateProject(db, roni, { id: 'BAD ID', name: 'x', type: 'short' }, NOW)), 400)
})

test('lists only what the person may open; only a manager renames or archives', async () => {
  const db = await withProject()
  assert.deepEqual(await pf.pfProjectsOf(db, 'roni1'), [])
  assert.equal(await status(pf.pfUpdateProject(db, 'roni1', P, { name: 'שלי' }, NOW)), 403)
  await pf.pfUpdateProject(db, 'maya1', P, { name: 'הבית', archived: true }, NOW + 1000)
  const [row] = await pf.pfProjectsOf(db, 'maya1')
  assert.deepEqual({ name: row.name, archived: row.archived, role: row.role }, { name: 'הבית', archived: true, role: 'manager' })
})

// ---- people ----

test('adds someone who uses the app by their email; an editor cannot add; an outsider sees nothing', async () => {
  const db = await withProject()
  const done = await pf.pfAddMember(db, 'maya1', P, ' Roni@Example.com ', 'editor', NOW)
  assert.equal(done.member.uid, 'roni1')
  assert.equal(await pf.pfRoleIn(db, P, 'roni1'), 'editor')
  assert.equal(await status(pf.pfAddMember(db, 'roni1', P, 'dana@example.com', 'viewer', NOW)), 403)
  const { members, invites } = await pf.pfMembersOf(db, 'maya1', P, NOW)
  assert.deepEqual(
    members.map((m: { email: string; role: string }) => [m.email, m.role]),
    [
      ['maya@example.com', 'manager'],
      ['roni@example.com', 'editor'],
    ],
  )
  assert.deepEqual(invites, [])
  assert.equal(await status(pf.pfMembersOf(db, 'dana1', P, NOW)), 404)
})

test('invites someone new by a link used once, before it runs out', async () => {
  const db = await withProject()
  const made = await pf.pfAddMember(db, 'maya1', P, 'dana@example.com', 'viewer', NOW)
  const { token } = made.invite
  assert.match(token, /^[a-z0-9]{32}$/)
  assert.equal((await pf.pfMembersOf(db, 'maya1', P, NOW)).invites.length, 1)
  const info = await pf.pfInviteInfo(db, token, NOW)
  assert.deepEqual({ name: info.projectName, role: info.role, from: info.from }, { name: 'הבית שעל הגבעה', role: 'viewer', from: 'מאיה' })
  assert.deepEqual(await pf.pfAcceptInvite(db, dana, token, NOW + 1000), { projectId: P, role: 'viewer' })
  assert.equal(await pf.pfRoleIn(db, P, 'dana1'), 'viewer')
  assert.equal(await status(pf.pfAcceptInvite(db, roni, token, NOW + 2000)), 410)
  const late = await pf.pfAddMember(db, 'maya1', P, 'late@example.com', 'editor', NOW)
  assert.equal(await status(pf.pfInviteInfo(db, late.invite.token, NOW + 15 * 86_400_000)), 410)
  assert.equal(await status(pf.pfCancelInvite(db, 'roni1', late.invite.token)), 403)
  await pf.pfCancelInvite(db, 'maya1', late.invite.token)
  assert.equal(await status(pf.pfInviteInfo(db, late.invite.token, NOW)), 404)
})

test('never lowers a role through an invitation, and never leaves a project without a manager', async () => {
  const db = await withProject()
  await pf.pfAddMember(db, 'maya1', P, 'roni@example.com', 'editor', NOW)
  const link = await pf.pfAddMember(db, 'maya1', P, 'someone@example.com', 'viewer', NOW)
  assert.deepEqual(await pf.pfAcceptInvite(db, roni, link.invite.token, NOW), { projectId: P, role: 'editor' })
  assert.equal(await status(pf.pfSetRole(db, 'maya1', P, 'maya1', 'editor')), 409)
  assert.equal(await status(pf.pfRemoveMember(db, 'maya1', P, 'maya1')), 409)
  await pf.pfSetRole(db, 'maya1', P, 'roni1', 'manager')
  await pf.pfSetRole(db, 'roni1', P, 'maya1', 'viewer')
  assert.equal(await pf.pfRoleIn(db, P, 'maya1'), 'manager') // she still owns the company
  assert.equal(await status(pf.pfRemoveMember(db, 'dana1', P, 'roni1')), 403) // an outsider removes nobody
  await pf.pfRemoveMember(db, 'roni1', P, 'maya1') // a manager may remove; she stays manager through her company
  assert.equal(await pf.pfRoleIn(db, P, 'maya1'), 'manager')
})

// ---- shared documents ----

test('lets an editor register a new document of the project on its first connection, and nobody else', async () => {
  const db = await withProject()
  await pf.pfAddMember(db, 'maya1', P, 'roni@example.com', 'viewer', NOW)
  const claim = { projectId: P, kind: 'script' }
  assert.equal(await pf.pfDocumentAccess(db, 'roni1', 'script000b1', claim, NOW), null)
  await pf.pfTouchUser(db, dana, NOW)
  assert.equal(await pf.pfDocumentAccess(db, 'dana1', 'script000b1', claim, NOW), null)
  assert.equal((await pf.pfDocumentAccess(db, 'maya1', 'script000b1', claim, NOW)).role, 'manager')
  assert.equal((await pf.pfDocumentAccess(db, 'roni1', 'script000b1', null, NOW)).role, 'viewer')
  const other = await pf.pfCreateProject(db, dana, { id: 'proj0000c1', name: 'אחר', type: 'short' }, NOW)
  assert.equal(await pf.pfDocumentAccess(db, 'dana1', 'script000b1', { projectId: other.id, kind: 'script' }, NOW), null)
  assert.equal(await pf.pfDocumentAccess(db, 'maya1', 'proj0000z9', { projectId: P, kind: 'project' }, NOW), null)
  assert.equal(await pf.pfDocumentAccess(db, 'maya1', '../etc', claim, NOW), null)
})

// ---- the requests ----

function caller() {
  const db = memStore()
  const resets: string[] = []
  const people: Record<string, typeof maya> = { 'token-maya': maya, 'token-roni': roni }
  const ctx = { store: db, verify: async (t: string) => people[t] ?? null, resetPassword: async (e: string) => void resets.push(e), now: NOW }
  const call = (body: Record<string, unknown>, token = '') => pf.pfHandle(body, token, ctx)
  return { db, ctx, call, resets }
}

test('answers only signed-in requests, in Hebrew when it refuses', async () => {
  const { call, ctx } = caller()
  assert.equal((await call({ op: 'me' })).status, 401)
  assert.deepEqual((await call({ op: 'me' }, 'forged')).body, { ok: false, error: 'צריך להתחבר מחדש.' })
  ctx.verify = async () => {
    throw new Error('Google is away')
  }
  assert.equal((await call({ op: 'me' }, 'token-maya')).status, 503)
  const none = { ...ctx, store: null, verify: async () => maya }
  assert.equal((await pf.pfHandle({ op: 'me' }, 'token-maya', none)).status, 503)
})

test('asks for a reset email without an account, and only for a real address', async () => {
  const { call, resets } = caller()
  assert.equal((await call({ op: 'password-reset', email: 'nope' })).status, 400)
  assert.equal((await call({ op: 'password-reset', email: 'maya@example.com' })).status, 200)
  assert.deepEqual(resets, ['maya@example.com'])
})

test('a whole round: a project, a person, an invitation, a room, the allowance', async () => {
  const { call } = caller()
  const me = await call({ op: 'me' }, 'token-maya')
  assert.equal(me.body.companies.length, 1)
  assert.equal((await call({ op: 'project-create', id: P, name: 'הבית', type: 'feature' }, 'token-maya')).status, 200)
  await call({ op: 'me' }, 'token-roni')
  const added = await call({ op: 'member-add', projectId: P, email: 'roni@example.com', role: 'viewer' }, 'token-maya')
  assert.equal(added.body.member.uid, 'roni1')
  assert.equal((await call({ op: 'member-add', projectId: P, email: 'x@example.com', role: 'boss' }, 'token-maya')).status, 400)
  const link = await call({ op: 'member-add', projectId: P, email: 'new@example.com', role: 'editor' }, 'token-maya')
  assert.equal((await call({ op: 'invite-info', token: link.body.invite.token }, 'token-roni')).body.invite.role, 'editor')
  // The sync Worker asks for a room: a viewer may read, may not register a new document.
  assert.deepEqual((await call({ op: 'room', doc: P }, 'token-roni')).body, { ok: true, uid: 'roni1', projectId: P, kind: 'project', role: 'viewer' })
  assert.equal((await call({ op: 'room', doc: 'script000b1', projectId: P, kind: 'script' }, 'token-roni')).status, 403)
  assert.equal((await call({ op: 'room', doc: 'script000b1', projectId: P, kind: 'script' }, 'token-maya')).body.role, 'manager')
  // The AI Worker: free has no month of its own.
  assert.deepEqual((await call({ op: 'quota' }, 'token-maya')).body, { ok: true, uid: 'maya1', plan: 'free', month: '2026-10', used: 0, perMonth: 0 })
  assert.equal((await call({ op: 'picture-take' }, 'token-maya')).body.ok, false)
  assert.equal((await call({ op: 'nonsense' }, 'token-maya')).status, 404)
})
