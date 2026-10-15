// Loads Preframe's section straight out of api/paypal.ts (everything between the PREFRAME
// markers), so the tests prove the code that actually runs. paypal.ts must stay self-contained
// (see the note at its top) and importing it would boot Firebase, so the section is cut out by
// text, given the imports it uses, and loaded as a module of its own. Also: a database in memory
// with the same promises as Firestore where the section leans on them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(join(root, 'api/paypal.ts'), 'utf8')
const start = src.indexOf('// >>> PREFRAME')
const end = src.indexOf('// <<< PREFRAME')
if (start < 0 || end < start) throw new Error('api/paypal.ts: the PREFRAME markers are missing')

const EXPORTS = [
  'pfHandle', 'pfAdminStore', 'PfConflict', 'PfRefused', 'pfAtomically', 'pfTouchUser', 'pfPlanOf', 'pfUsageOf', 'pfTakePicture',
  'pfSettlePicture', 'pfGrant', 'pfArrive', 'pfRoleIn', 'pfProjectsOf', 'pfCreateProject', 'pfUpdateProject', 'pfMembersOf',
  'pfAddMember', 'pfSetRole', 'pfRemoveMember', 'pfCancelInvite', 'pfInviteInfo', 'pfAcceptInvite', 'pfDocumentAccess', 'PF_PICTURES_A_MONTH',
]
// Inside the repository (git-ignored), so the module finds firebase-admin like paypal.ts does.
const dir = join(root, 'tests/.gen')
mkdirSync(dir, { recursive: true })
const file = join(dir, 'section.ts')
writeFileSync(
  file,
  [
    "import crypto from 'node:crypto'",
    "import { Timestamp, type Firestore } from 'firebase-admin/firestore'",
    src.slice(start, end),
    `export { ${EXPORTS.join(', ')} }`,
  ].join('\n'),
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pf: any = await import(pathToFileURL(file).href)

// ---- the database in memory ----

type Value = string | number | boolean | null | Value[] | { [key: string]: Value }
type Fields = { [key: string]: Value }
interface Snapshot {
  path: string
  id: string
  data: Fields
  version: string
}
type Filter = [string, '==' | 'array-contains' | 'in', Value]
type Write = { op: 'create' | 'set' | 'update' | 'delete'; path: string; data?: Fields; ifVersion?: string }

const same = (a: Value | undefined, b: Value) => JSON.stringify(a) === JSON.stringify(b)

export function memStore() {
  const docs = new Map<string, { data: Fields; version: number }>()
  let clock = 0
  const snap = (path: string, d: { data: Fields; version: number }): Snapshot => ({ path, id: path.slice(path.lastIndexOf('/') + 1), data: structuredClone(d.data), version: String(d.version) })
  const store = {
    commits: 0,
    async get(path: string) {
      const d = docs.get(path)
      return d ? snap(path, d) : null
    },
    async getAll(paths: string[]) {
      return Promise.all(paths.map((p) => store.get(p)))
    },
    async query(collection: string, filters: Filter[], limit?: number) {
      const out: Snapshot[] = []
      for (const [path, d] of docs) {
        if (path.slice(0, path.lastIndexOf('/')) !== collection) continue
        const pass = filters.every(([field, op, value]) => {
          const have = d.data[field]
          if (op === '==') return same(have, value)
          if (op === 'array-contains') return Array.isArray(have) && have.some((v) => same(v, value))
          return Array.isArray(value) && value.some((v) => same(have, v))
        })
        if (pass) out.push(snap(path, d))
        if (limit && out.length >= limit) break
      }
      return out
    },
    async commit(writes: Write[]) {
      store.commits++
      const next = new Map<string, { data: Fields; version: number } | undefined>()
      for (const w of writes) {
        const d = next.has(w.path) ? next.get(w.path) : docs.get(w.path)
        if (w.ifVersion !== undefined && (!d || String(d.version) !== w.ifVersion)) throw new pf.PfConflict('changed')
        if (w.op === 'create' && d) throw new pf.PfConflict('exists')
        if (w.op === 'update' && !d) throw new pf.PfConflict('missing')
        const version = ++clock
        if (w.op === 'delete') next.set(w.path, undefined)
        else if (w.op === 'update') next.set(w.path, { data: { ...d!.data, ...structuredClone(w.data!) }, version })
        else next.set(w.path, { data: structuredClone(w.data!), version })
      }
      for (const [path, d] of next) {
        if (d) docs.set(path, d)
        else docs.delete(path)
      }
    },
    dump: () => Object.fromEntries([...docs].map(([p, d]) => [p, structuredClone(d.data)])) as Record<string, Fields>,
  }
  return store
}
