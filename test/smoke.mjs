/**
 * Smoke test: load the client bundle under a fake ModuleLoader and fake ctx,
 * then assert the registrations apply() performs.
 *
 *   node test/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(path.join(root, 'client.js'), 'utf8')

const calls = { types: [], slots: [], shortcuts: [] }
let captured = null

const fakeWindow = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

const fakeRequire = (id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
}

const context = vm.createContext({ window: fakeWindow, console, setTimeout, clearTimeout, setInterval, clearInterval })
vm.runInContext(source, context, { filename: 'client.js' })

if (!captured) throw new Error('bundle did not call __ModuleLoader__.load')
if (captured.id !== 'dsh-ide-pane') throw new Error(`unexpected id ${captured.id}`)

const mod = captured.factory(fakeRequire)
if (!mod || typeof mod.apply !== 'function') throw new Error('factory did not return a plugin with apply()')
if (!Array.isArray(mod.inject)) throw new Error('plugin inject must be an array')

const disposable = () => () => {}

const fakeCtx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(names, cb) {
    cb(fakeCtx)
  },
  sessions: { list: { byId: {} } },
  remote: {},
  sidebarRight: {
    commandTarget: () => ({ session: 's1' }),
    openTabFromTarget: () => {},
  },
  sidebarRightTabs: {
    register(definition) {
      if (!definition.kind) throw new Error('type without kind')
      if (!definition.id) throw new Error('type without id')
      if (calls.types.some((entry) => entry.id === definition.id)) throw new Error('duplicate id')
      calls.types.push(definition)
      return disposable()
    },
  },
  slots: {
    inject(name, register) {
      return register()
    },
    register(definition, component) {
      if (!definition.name) throw new Error('slot without name')
      if (typeof component !== 'function') throw new Error('slot without component')
      calls.slots.push({ definition, component })
      return disposable()
    },
  },
  shortcuts: {
    register(definition) {
      if (!Array.isArray(definition.regions)) throw new Error('shortcut without regions')
      calls.shortcuts.push(definition)
      return disposable()
    },
  },
}

mod.apply(fakeCtx)

const type = calls.types[0]
if (!type) throw new Error('no tab type registered')
if (type.kind !== 'ide') throw new Error(`unexpected kind ${type.kind}`)
if (typeof type.title !== 'function') throw new Error('type title must be a function')
if (!Array.isArray(type.guide) || type.guide.length === 0) throw new Error('type lost its guide entry')

// A file reference in the chat must land here, so the type has to claim file
// addresses itself rather than waiting to be opened by name.
if (!Array.isArray(type.patterns) || type.patterns.length === 0) throw new Error('type claims no address pattern')
if (!type.patterns.some((pattern) => pattern.startsWith('dsh-resource://file/'))) throw new Error('type does not claim file addresses')
if (typeof type.canOpen !== 'function') throw new Error('type does not veto addresses it cannot show')
if (type.canOpen('dsh-resource://file/session/s1/D:/a.py') !== true) throw new Error('a source file must be claimable')
if (type.canOpen('dsh-resource://file/session/s1/D:/logo.png') !== false) throw new Error('a binary file must not be claimed')
if (type.canOpen('dsh-resource://page/ide') !== false) throw new Error('a page address must not be claimed')
if (type.title('dsh-resource://file/session/s1/D:/proj/x.py') !== 'x.py') throw new Error('the tab chip must name the file')
if (type.title('dsh-resource://page/ide') !== '代码') throw new Error('the guide tab keeps the pane name')

const body = calls.slots.find((entry) => entry.definition.name === 'sidebar.right.pane.tab')
const title = calls.slots.find((entry) => entry.definition.name === 'sidebar.right.pane.tab.title')
if (!body) throw new Error('no pane body registered')
if (!title) throw new Error('no pane title registered')
if (body.definition.key !== type.id) throw new Error('body key must equal the type id')
if (typeof body.definition.inject !== 'function') throw new Error('body must inject the session store')

const injected = body.definition.inject('s1', {})
if (!injected || !injected.sessions) throw new Error('body inject did not provide sessions')

if (calls.shortcuts.length !== 1) throw new Error('expected exactly one shortcut')
const command = calls.shortcuts[0]
const resolved = command.resolve({ target: null })
if (resolved.status !== 'handled') throw new Error(`shortcut did not handle: ${JSON.stringify(resolved)}`)

console.log('ok: type=%s slots=%d shortcuts=%d', type.kind, calls.slots.length, calls.shortcuts.length)
console.log('guide=%s', JSON.stringify(type.guide.map((entry) => entry.title())))
