/**
 * Render smoke test: drive the tab body with a minimal hook runtime and a fake
 * `remote.workspaceFiles`, then assert the tree, the open file, and the
 * colourisation all come out.
 *
 *   node test/render.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// ── load the bundle under a fake ModuleLoader ───────────────────────────────
let captured = null
const fakeWindow = {
  __ModuleLoader__: { load: (entry) => (captured = entry) },
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1200,
  innerHeight: 900,
}

const React = createReact()

/** Registered interval callbacks, so the poll can be driven by hand. */
const intervals = []

/** Everything the pane copied, in order. */
const copied = []

/** A node type so `instanceof Node` guards inside the bundle can be answered. */
class FakeNode {}

/**
 * A document that only remembers listeners, enough to dispatch the events the
 * pane binds outside its own subtree.
 */
const listeners = new Map()
const fakeDocument = {
  // The pane injects one stylesheet; a stub element is enough to hold it.
  createElement: () => ({ setAttribute: () => {}, remove: () => {}, textContent: '' }),
  head: { appendChild: () => {} },
  documentElement: { removeAttribute: () => {}, toggleAttribute: () => {}, hasAttribute: () => false },
  addEventListener(type, handler) {
    const list = listeners.get(type) ?? []
    list.push(handler)
    listeners.set(type, list)
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type) ?? []
    listeners.set(type, list.filter((entry) => entry !== handler))
  },
}

/** Fire one captured document listener. */
function dispatch(type, event) {
  for (const handler of listeners.get(type) ?? []) handler(event)
}

function createReact() {
  const ctx = { hooks: [], index: 0, dirty: false, effects: [] }

  const api = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) }
    },
    useState(init) {
      const slot = (ctx.hooks[ctx.index] ??= {});
      if (slot.state === undefined && !slot.init) {
        slot.state = typeof init === 'function' ? init() : init
        slot.init = true
      }
      const set = (next) => {
        slot.state = typeof next === 'function' ? next(slot.state) : next
        ctx.dirty = true
      }
      ctx.index += 1
      return [slot.state, set]
    },
    useMemo(fn, deps) {
      const slot = (ctx.hooks[ctx.index] ??= {})
      if (!slot.memo || !same(deps, slot.deps)) {
        slot.memo = fn()
        slot.deps = deps
      }
      ctx.index += 1
      return slot.memo
    },
    useCallback(fn, deps) {
      return api.useMemo(() => fn, deps)
    },
    useRef(init) {
      const slot = (ctx.hooks[ctx.index] ??= {})
      if (!slot.ref) slot.ref = { current: init }
      ctx.index += 1
      return slot.ref
    },
    useEffect(fn, deps) {
      const slot = (ctx.hooks[ctx.index] ??= {})
      if (!slot.ran || !same(deps, slot.deps)) {
        slot.effect = fn
        slot.deps = deps
        slot.ran = true
        ctx.effects.push(slot)
      }
      ctx.index += 1
    },
  }

  api.__ctx = ctx
  return api
}

function same(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, i) => Object.is(value, b[i]))
}

const fakeRequire = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require ${id}`)
}

const hostCalls = []
let contentVersion = 'v1'
const fakeFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  hostCalls.push({ url, body })
  if (String(url).endsWith('/edits')) {
    return {
      text: async () => JSON.stringify({
        ok: true,
        seq: 9,
        files: {
          'D:/proj/a.py': [
            { seq: 11, at: 1700000000000, tool: 'edit', kind: 'replace', oldLines: 2, newLines: 2 },
            { seq: 12, at: 1700000060000, tool: 'write', kind: 'write', oldLines: null, newLines: 3 },
          ],
          // A relative key: the pane anchors it on the session root.
          'sub/b.js': [{ seq: 13, at: 1700000120000, tool: 'edit', kind: 'replace', oldLines: 1, newLines: 1 }],
          // Enough edits to exercise the strip's folding.
          'D:/proj/heavy.py': Array.from({ length: 15 }, (_, i) => ({
            seq: 200 + i,
            at: 1700000000000 + i * 60000,
            tool: 'edit',
            kind: 'replace',
            oldLines: 1,
            newLines: 1,
          })),
        },
      }),
    }
  }
  if (String(url).endsWith('/editText')) {
    if (Number(body.seq) === 12) {
      return { text: async () => JSON.stringify({ ok: true, kind: 'write', old: null, new: 'brand new\nfile\n' }) }
    }
    return {
      text: async () => JSON.stringify({
        ok: true,
        kind: 'replace',
        old: 'def f(a):\n    return a + 1',
        new: 'def f(a):\n    return a + 2',
      }),
    }
  }
  if (String(url).endsWith('/stat')) return { text: async () => JSON.stringify({ ok: true, exists: true, version: contentVersion, bytes: 40 }) }
  if (String(url).endsWith('/write')) {
    if (body.baseVersion !== contentVersion) {
      return { text: async () => JSON.stringify({ ok: false, conflict: true, currentVersion: contentVersion, currentText: FILES[body.path] }) }
    }
    contentVersion = 'v2'
    FILES[body.path] = body.text
    return { text: async () => JSON.stringify({ ok: true, bytes: body.text.length, version: contentVersion }) }
  }
  return { text: async () => JSON.stringify({ ok: true, code: 0, stdout: 'ran ok', stderr: '', ms: 12, command: 'node x' }) }
}

const context = vm.createContext({
  window: fakeWindow,
  console,
  fetch: fakeFetch,
  setTimeout,
  clearTimeout,
  setInterval: (fn) => {
    intervals.push(fn)
    return intervals.length
  },
  clearInterval: () => {},
  // Clipboard and DOM listeners are what drag, copy, and the row menu need.
  navigator: { clipboard: { writeText: async (text) => { copied.push(text) } } },
  AbortController,
  TextDecoder,
  TextEncoder,
  document: fakeDocument,
  Node: FakeNode,
})
vm.runInContext(readFileSync(path.join(root, 'client.js'), 'utf8'), context, { filename: 'client.js' })
/** A fetch response that hands back a `text/event-stream` body. */
function sseResponse(frames, chunkSize = 7) {
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  let offset = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (offset >= bytes.length) return Promise.resolve({ done: true, value: undefined })
            const end = Math.min(bytes.length, offset + chunkSize)
            const value = bytes.slice(offset, end)
            offset = end
            return Promise.resolve({ done: false, value })
          },
          cancel() {
            return Promise.resolve()
          },
        }
      },
    },
  }
}

const originalFetch = context.fetch
let streamMode = 'normal'
context.fetch = async (url, init) => {
  if (String(url).endsWith('/runStream')) {
    if (streamMode === 'never') {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            // A real body reader rejects when the fetch is aborted; without
            // that, the pane would have no way to notice a stop.
            read: () =>
              new Promise((_resolve, reject) => {
                const signal = init && init.signal
                if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
              }),
            cancel: () => Promise.resolve(),
          }),
        },
      }
    }
    return sseResponse([
      { type: 'start', command: 'python "D:/proj/a.py"' },
      { type: 'out', text: '\u001b[32mfirst line\u001b[0m\n' },
      { type: 'out', text: 'progress 10%\rprogress 90%\n' },
      { type: 'end', code: 0, ok: true, ms: 42 },
    ])
  }
  return originalFetch(url, init)
}

// ── fake Remote ────────────────────────────────────────────────────────────
const TREE = {
  'D:/proj': [
    { name: 'sub', type: 'directory' },
    { name: 'a.py', type: 'file' },
    { name: 'heavy.py', type: 'file' },
    { name: 'notes.md', type: 'file' },
  ],
  'D:/proj/sub': [{ name: 'b.js', type: 'file' }],
}
const FILES = {
  'D:/proj/a.py': 'import re\n\ndef f(a):\n    return a + 1\n',
  'D:/proj/heavy.py': 'x = 1\n',
  'D:/proj/notes.md': [
    '# 标题一',
    '',
    '一段带 **粗体** 和 `代码` 的说明。',
    '',
    '## 表格',
    '',
    '| 名称 | 说明 |',
    '| --- | --- |',
    '| alpha | 第一项 |',
    '| beta | 第二项 |',
    '',
    '- 列表项一',
    '- 列表项二',
    '  - 嵌套项',
    '',
    '1. 有序一',
    '2. 有序二',
    '',
    '> 引用的一段话',
    '',
    '```py',
    'print("fenced")',
    '```',
    '',
    '- [x] 已完成',
    '- [ ] 未完成',
    '',
    '---',
    '',
    '[链接](https://example.com) 结尾。',
    '',
    '误差约为 $\\sim10^{-3}$，比例是 $\\frac{a}{b}$。',
    '',
    '价格是 $5 和 $10，这里不该当成公式。',
    '',
    '预测值 $\\hat{y}_i$，围栏 $\\left( a+b \\right)$，间距 $a\\,b$。',
    '',
    '成本 $8，误差 $\\hat r=8$，随后 $\\hat k=2$。',
    '',
    '\\#2 锁在一起：$\\beta \\gtrsim 0$，$r=768$，**也就是说：在 $768$ 维、$\\hat r=8$ 时假设为空。**',
    '$$',
    '\\sum_{i=1}^{n} x_i \\approx \\infty',
    '$$',
    '',
  ].join('\n'),
  'D:/proj/sub/b.js': Array.from({ length: 12 }, (_, i) => `const v${i} = ${i}`).join('\n') + '\n',
}
const calls = []
/** Version the fake `workspaceFiles.stat` reports; the poll compares it. */
let remoteVersion = 1

const remote = {
  workspaceFiles: {
    async list(sessionId, dir) {
      calls.push(['list', sessionId, dir])
      const entries = TREE[dir]
      if (!entries) return { ok: false, error: { code: 'workspace-file/not-found' } }
      return { ok: true, value: { path: dir, entries, truncated: false } }
    },
    async read(sessionId, file) {
      calls.push(['read', sessionId, file])
      const text = FILES[file]
      if (text === undefined) return { ok: false, error: { code: 'workspace-file/not-found' } }
      return { ok: true, value: { version: 1, text, lines: text.split('\n').length, eof: true } }
    },
    async stat() {
      return { ok: true, value: { version: remoteVersion } }
    },
  },
}

// ── fake ctx, identical shape to the smoke test ────────────────────────────
const slots = []
const fakeCtx = {
  effect: (fn) => fn() || (() => {}),
  inject: (names, cb) => cb(fakeCtx),
  sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: 'D:/proj' } } }) } },
  remote,
  sidebarRight: { commandTarget: () => ({}), openTabFromTarget: () => {} },
  sidebarRightTabs: { register: () => () => {} },
  shortcuts: { register: () => () => {} },
  slots: {
    inject: (name, register) => register(),
    register: (definition, component) => {
      slots.push({ definition, component })
      return () => {}
    },
  },
}

const plugin = captured.factory(fakeRequire)
plugin.apply(fakeCtx)

// ── pure helpers ───────────────────────────────────────────────────────────
const { diffLines, selectedLines, lineReference } = plugin.__test

// identical texts produce only "same" rows
const equalRows = diffLines('a\nb\nc', 'a\nb\nc')
assert.equal(equalRows.length, 3)
assert.ok(equalRows.every((row) => row.type === 'same'), 'identical texts must diff clean')

// a single edited line keeps the neighbours aligned
const edited = diffLines('a\nb\nc', 'a\nB\nc')
assert.equal(edited.map((row) => row.type).join(','), 'same,del,add,same')
assert.equal(edited[1].text, 'b')
assert.equal(edited[1].aLine, 2)
assert.equal(edited[2].text, 'B')
assert.equal(edited[2].bLine, 2)

// an insertion is one add with no deletion
const insertedRows = diffLines('a\nc', 'a\nb\nc')
assert.equal(insertedRows.map((row) => row.type).join(','), 'same,add,same')

// a deletion is one del
const deletedRows = diffLines('a\nb\nc', 'a\nc')
assert.equal(deletedRows.map((row) => row.type).join(','), 'same,del,same')

// a whole-file rewrite still returns a usable diff and does not throw
const rewritten = diffLines(Array.from({ length: 900 }, (_, i) => `old ${i}`).join('\n'), Array.from({ length: 900 }, (_, i) => `new ${i}`).join('\n'))
assert.ok(rewritten.some((row) => row.type === 'del'))
assert.ok(rewritten.some((row) => row.type === 'add'))

// line references round-trip, including a path that needs quoting
assert.equal(lineReference('a.py', 8, 10), '@a.py:8-10')
assert.equal(lineReference('a.py', 8, 8), '@a.py:8')
assert.equal(lineReference('my dir/a b.py', 1, 2), '@"my dir/a b.py":1-2')

// a selection ending at a line boundary belongs to the line it started on
assert.equal(JSON.stringify(selectedLines('one\ntwo\nthree\n', 4, 8)), JSON.stringify({ start: 2, end: 2 }))
assert.equal(JSON.stringify(selectedLines('one\ntwo\nthree\n', 0, 8)), JSON.stringify({ start: 1, end: 2 }))
assert.equal(selectedLines('one\ntwo\n', 3, 3), null, 'an empty selection has no reference')

// baselines round-trip per session and file, and refuse oversized files
const { readVersion, observeVersion, clearVersion } = plugin.__test

// A file seen for the first time has nothing to compare against.
assert.equal(readVersion('s9', 'x.txt'), null, 'an unseen file has no record')
const first = observeVersion('s9', 'x.txt', 'v1')
assert.equal(first.prev, null)
assert.equal(readVersion('s9', 'x.txt').text, 'v1')

// Reading the same content again leaves the record, and the last change, alone.
const again = observeVersion('s9', 'x.txt', 'v1')
assert.equal(again.prev, null, 'an unchanged read must not invent a comparison')
assert.equal(readVersion('s9', 'x.txt').text, 'v1')

// A real change repoints the comparison at the text observed just before it.
const changed = observeVersion('s9', 'x.txt', 'v2')
assert.equal(changed.prev, 'v1')
assert.equal(readVersion('s9', 'x.txt').text, 'v2')
assert.equal(readVersion('s9', 'x.txt').prev, 'v1')

// Re-reading after the change keeps that comparison: this is what makes it
// survive closing the diff, switching tabs, and reloading the page.
const reread = observeVersion('s9', 'x.txt', 'v2')
assert.equal(reread.prev, 'v1', 'a reload must not drop the pending comparison')

// A second change shifts it forward rather than accumulating history.
const second = observeVersion('s9', 'x.txt', 'v3')
assert.equal(second.prev, 'v2')

// Files and sessions keep separate records.
observeVersion('s9', 'y.txt', 'other')
assert.equal(readVersion('s9', 'y.txt').text, 'other')
assert.equal(readVersion('other-session', 'x.txt'), null)

// The same file reached through either separator shares one record.
observeVersion('s9', 'D:/proj/a.py', 'one')
assert.equal(observeVersion('s9', 'D:\\proj\\a.py', 'two').prev, 'one', 'path spellings must share a record')

// Clearing forgets the comparison but keeps the text.
clearVersion('s9', 'x.txt')
assert.equal(readVersion('s9', 'x.txt').text, 'v3')
assert.equal(readVersion('s9', 'x.txt').prev, null)
assert.equal(observeVersion('s9', 'x.txt', 'v3').prev, null, 'a cleared record stays cleared until the next change')

// An oversized file keeps no record at all.
observeVersion('s9', 'big.txt', 'a'.repeat(200001))
assert.equal(readVersion('s9', 'big.txt'), null, 'an oversized file keeps no record')


// ── file addresses ────────────────────────────────────────────────────────
const { parseFileAddress, openableFileAddress, titleForAddress } = plugin.__test

assert.equal(JSON.stringify(parseFileAddress('dsh-resource://file/session/s1/D:/proj/a.py')), JSON.stringify({ scope: 'session', sessionId: 's1', path: 'D:/proj/a.py' }))
assert.equal(parseFileAddress('dsh-resource://file/session/s1/a%20b.py').path, 'a b.py', 'a segment must be decoded on its own')
assert.equal(parseFileAddress('dsh-resource://file/absolute/D:/x/y.py').path, 'D:/x/y.py')
assert.equal(parseFileAddress('dsh-resource://file/absolute//srv/share/x.py').path, '//srv/share/x.py', 'a UNC address keeps both leading slashes')
assert.equal(parseFileAddress('dsh-resource://file/session/s1'), null, 'an address with no path is not a file')
assert.equal(parseFileAddress('dsh-resource://page/ide'), null, 'a page address is not a file')
assert.equal(parseFileAddress('https://example.com/a.py'), null)
assert.equal(parseFileAddress(undefined), null)

assert.equal(openableFileAddress('dsh-resource://file/session/s1/D:/proj/a.py'), true)
assert.equal(openableFileAddress('dsh-resource://file/session/s1/D:/proj/Makefile'), true, 'no suffix counts as text')
assert.equal(openableFileAddress('dsh-resource://file/session/s1/D:/proj/.env'), true, 'a dotfile counts as text')
assert.equal(openableFileAddress('dsh-resource://file/session/s1/D:/proj/logo.png'), false, 'an image must keep the shipped preview')
assert.equal(openableFileAddress('dsh-resource://file/session/s1/D:/proj/doc.pdf'), false)
assert.equal(openableFileAddress('dsh-resource://page/ide'), false, 'the guide page is not claimed by the file glob')

assert.equal(titleForAddress('dsh-resource://file/session/s1/D:/proj/sub/b.js'), 'b.js')
assert.equal(titleForAddress('dsh-resource://page/ide'), '代码')

// ── ANSI output ───────────────────────────────────────────────────────────
const { ansiSegments, ANSI_COLOR } = plugin.__test

// Plain output must stay one node: no escapes, no allocation.
assert.equal(ansiSegments('plain text'), null, 'plain output must not be split')
assert.equal(ansiSegments(''), null)

const red = ansiSegments('\u001b[31mred\u001b[0m done')
assert.equal(red.length, 2)
assert.equal(red[0].text, 'red')
assert.equal(red[0].color, ANSI_COLOR[31])
assert.equal(red[1].text, ' done')
assert.equal(red[1].color, undefined, 'a reset must clear the colour')

const bold = ansiSegments('\u001b[1;32mok\u001b[0m')
assert.equal(bold[0].bold, true)
assert.equal(bold[0].color, ANSI_COLOR[32])

// 38;5;196 names a 256-colour slot; its arguments must not be read as codes.
const extended = ansiSegments('\u001b[38;5;196mx\u001b[0m')
assert.equal(extended[0].color, undefined, 'an extended colour must not be misread as a plain one')
assert.equal(extended[0].text, 'x')

const truecolor = ansiSegments('\u001b[38;2;10;20;30my\u001b[0m')
assert.equal(truecolor[0].color, undefined)
assert.equal(truecolor[0].text, 'y')

// An escape with no reset carries its style to the end.
const open = ansiSegments('\u001b[33mwarn')
assert.equal(open.length, 1)
assert.equal(open[0].text, 'warn')
assert.equal(open[0].color, ANSI_COLOR[33])

// A bare reset is a no-op, and 22 turns bold off again.
assert.equal(ansiSegments('\u001b[0mplain').length, 1)
const unbold = ansiSegments('\u001b[1mbig\u001b[22mnormal')
assert.equal(unbold[0].bold, true)
assert.equal(unbold[1].text, 'normal')
assert.equal(unbold[1].bold, false)



const bodySlot = slots.find((entry) => entry.definition.name === 'sidebar.right.pane.tab')
if (!bodySlot) throw new Error('pane body was not registered')

// ── render loop ────────────────────────────────────────────────────────────
const hookCtx = React.__ctx

function paint(props) {
  hookCtx.index = 0
  hookCtx.effects = []
  hookCtx.dirty = false
  const tree = bodySlot.component(props)
  return { tree, effects: hookCtx.effects.slice() }
}

async function settle(props, budget = 40) {
  let view = paint(props)
  for (let round = 0; round < budget; round += 1) {
    const effects = view.effects
    hookCtx.effects = []
    for (const slot of effects) {
      if (typeof slot.effect === 'function') slot.effect()
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!hookCtx.dirty) break
    view = paint(props)
  }
  return view.tree
}

/**
 * Concatenate a subtree's text with no separator.
 *
 * File names are rendered as a base plus a dimmed extension, so "a.py" is two
 * text nodes. Matching on the concatenation is what a reader actually sees.
 */
function flatText(node) {
  return texts(node).join('')
}

/** Find the first clickable ancestor whose subtree renders the given text. */
function findClickable(node, text, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findClickable(child, text, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.props.onClick === 'function' && flatText(node).includes(text)) out.push(node)
  for (const child of node.children || []) findClickable(child, text, out)
  return out
}

/** Collect every element whose children include the given text. */
function findByText(node, text, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findByText(child, text, out)
    return out
  }
  if (typeof node !== 'object') return out
  const kids = node.children || []
  if (kids.includes(text)) out.push(node)
  for (const child of kids) findByText(child, text, out)
  return out
}

/** Flatten to a readable dump for assertions. */
function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node !== 'object') return out
  for (const child of node.children || []) texts(child, out)
  return out
}

const inserted = []
const props = {
  sessionId: 's1',
  sessions: fakeCtx.sessions.list,
  inputActions: {
    captureInsertion: () => ({ revision: 1 }),
    insertText: (text, span) => { inserted.push({ text, span }); return true },
  },
}

let tree = await settle(props)
let dump = flatText(tree)
if (!dump.includes('a.py')) throw new Error(`tree missing a.py: ${dump.slice(0, 200)}`)
if (!dump.includes('sub')) throw new Error('tree missing directory sub')
if (!dump.includes('从左侧选择一个文件')) throw new Error('empty state missing')
if (!dump.includes('D:/proj')) throw new Error('idle state did not name the workspace')

// click a.py
const row = findClickable(tree, 'a.py')[0]
if (!row || typeof row.props.onClick !== 'function') throw new Error('a.py row is not clickable')
row.props.onClick()
tree = await settle(props)
const codeDump = texts(tree).join('')

if (!codeDump.includes('import')) throw new Error(`file text did not render: ${codeDump.slice(0, 200)}`)
if (!codeDump.includes('D:/proj/a.py')) throw new Error('breadcrumb did not follow the open file')
if (!calls.some(([kind, , target]) => kind === 'read' && target === 'D:/proj/a.py')) {
  throw new Error(`read was not called: ${JSON.stringify(calls)}`)
}

// the diff entry point is always present, even before anything changed:
// a disappearing button is what made the feature look broken.
const quietDiff = findClickable(tree, '差异')[0]
if (!quietDiff) throw new Error('the diff button is missing on a freshly opened file')
if (findClickable(tree, '差异 •')[0]) throw new Error('a freshly opened file must not claim changes')
quietDiff.props.onClick()
tree = await settle(props)
if (!texts(tree).join('|').includes('两边内容相同')) throw new Error('an unchanged file did not explain why the diff is empty')
quietDiff.props.onClick()
tree = await settle(props)

// colourisation: the keyword span carries a colour style
function spans(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) spans(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.type === 'span' && node.props.style && node.props.style.color) out.push(node)
  for (const child of node.children || []) spans(child, out)
  return out
}
const coloured = spans(tree)
if (coloured.length === 0) throw new Error('no colourised token spans')
const keywords = coloured.filter((node) => node.children.includes('import'))
if (keywords.length !== 1) throw new Error('import was not colourised as one token')

// expand the directory
const dirRow = findClickable(tree, 'sub')[0]
dirRow.props.onClick()
tree = await settle(props)
const expanded = flatText(tree)
if (!expanded.includes('b.js')) throw new Error(`directory did not expand: ${expanded.slice(0, 300)}`)

// the trace view was removed: no rail segment may remain
if (texts(tree).join('|').includes('轨迹')) throw new Error('the removed trace tab is still rendered')

// ── edit and selection reference ──────────────────────────────────────────
function findTag(node, tag, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findTag(child, tag, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.type === tag) out.push(node)
  for (const child of node.children || []) findTag(child, tag, out)
  return out
}

const editBtn = findClickable(tree, '编辑')[0]
if (!editBtn) throw new Error('no edit button')
editBtn.props.onClick()
tree = await settle(props)

const area = findTag(tree, 'textarea')[0]
if (!area) throw new Error('edit mode did not render a textarea')
if (!String(area.props.value).includes('import re')) throw new Error('textarea did not start from the file text')

// the editor is no longer a bare textarea: gutter, highlight layer, status bar
const editorDump = texts(tree).join('|')
if (!editorDump.includes('行 1，列 1')) throw new Error(`status bar is missing the caret readout: ${editorDump.slice(0, 300)}`)
if (!editorDump.includes('未修改')) throw new Error('a freshly opened draft must read as unmodified')
const overlay = findTag(tree, 'pre').find((node) => Array.isArray(node.children) && node.children.length > 0)
if (!overlay) throw new Error('the highlight overlay was not rendered')
const overlaySpans = spans(overlay)
if (overlaySpans.length === 0) throw new Error('the highlight overlay carries no coloured tokens')
if (area.props.wrap !== 'off') throw new Error('the editor must not soft-wrap, or rows drift from the gutter')

// select lines 2-3 and insert a stable @file:line-range reference
const source = String(area.props.value)
const start = source.indexOf('\n') + 1
const end = source.indexOf('def f') + 'def f(a):'.length
area.props.onSelect({ currentTarget: { value: source, selectionStart: start, selectionEnd: end } })
tree = await settle(props)
const refBtn = findClickable(tree, '引用到对话')[0]
if (!refBtn) throw new Error('selection reference bar did not appear')
refBtn.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
if (inserted.length !== 1) throw new Error(`reference was not inserted: ${JSON.stringify(inserted)}`)
if (inserted[0].text !== '@D:/proj/a.py:2-3 ') throw new Error(`wrong line reference: ${inserted[0].text}`)

area.props.onChange({ target: { value: 'print("edited")\n' } })
tree = await settle(props)
if (!texts(tree).join('|').includes('已修改')) throw new Error('the status bar did not report the draft as modified')

const saveBtn = findClickable(tree, '保存')[0]
if (!saveBtn) throw new Error('no save button')
saveBtn.props.onClick()
tree = await settle(props)

const writeCall = hostCalls.find((entry) => entry.url.endsWith('/write'))
if (!writeCall) throw new Error(`save did not reach the host: ${JSON.stringify(hostCalls)}`)
if (writeCall.body.path !== 'D:/proj/a.py') throw new Error(`wrong write path ${writeCall.body.path}`)
if (writeCall.body.text !== 'print("edited")\n') throw new Error('wrong write text')
if (writeCall.body.root !== 'D:/proj') throw new Error(`wrong write root ${writeCall.body.root}`)
if (writeCall.body.baseVersion !== 'v1') throw new Error(`save omitted content version: ${JSON.stringify(writeCall.body)}`)
if (findTag(tree, 'textarea').length !== 0) throw new Error('save did not leave edit mode')

// ── the Agent rewrites the open file: show what changed ───────────────────
// Open b.js so the baseline is its original 12 lines, then have the Agent
// rewrite exactly one of them.
const bRow = findClickable(tree, 'b.js')[0]
if (!bRow) throw new Error('b.js is not reachable after the run flow')
bRow.props.onClick()
tree = await settle(props)

const bjsBefore = FILES['D:/proj/sub/b.js']
FILES['D:/proj/sub/b.js'] = bjsBefore.replace('const v6 = 6', 'const v6 = 60')
remoteVersion = 2
const poll = intervals[intervals.length - 1]
if (typeof poll !== 'function') throw new Error('the follow-the-file poll was never registered')
poll()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle(props)

const diffBtn = findClickable(tree, '差异 •')[0]
if (!diffBtn) throw new Error('agent-rewrite did not offer a diff')
diffBtn.props.onClick()
tree = await settle(props)
const diffRows = texts(tree)
const diffDump = diffRows.join('|')
if (!diffDump.includes('行未变')) throw new Error(`diff did not collapse unchanged lines: ${diffDump.slice(0, 400)}`)
if (!diffRows.includes('const v6 = 6')) throw new Error(`diff did not show the removed line: ${diffDump.slice(0, 400)}`)
if (!diffRows.includes('const v6 = 60')) throw new Error(`diff did not show the added line: ${diffDump.slice(0, 400)}`)
if (!diffRows.includes('-')) throw new Error('diff did not mark the removal')
if (!diffRows.includes('+')) throw new Error('diff did not mark the addition')

// closing the diff and reopening it must show the same comparison: the record
// lives in storage, not in the view state.
diffBtn.props.onClick()
tree = await settle(props)
if (texts(tree).join('|').includes('行未变')) throw new Error('closing the diff left the diff view open')
const reopened = findClickable(tree, '差异 •')[0]
if (!reopened) throw new Error('closing the diff dropped the pending comparison')
reopened.props.onClick()
tree = await settle(props)
if (!texts(tree).join('|').includes('行未变')) throw new Error('reopening the diff lost the comparison')

// the explicit clear is the only thing that forgets it
const clearBtn = findClickable(tree, '清除对比')[0]
if (!clearBtn) throw new Error('no explicit clear action while a comparison is pending')
clearBtn.props.onClick()
tree = await settle(props)
if (findClickable(tree, '差异 •')[0]) throw new Error('clear did not forget the comparison')

// ── the baseline survives leaving a file and coming back ──────────────────
const openedAgain = findClickable(tree, 'a.py')[0]
if (!openedAgain) throw new Error('a.py is not reachable for the baseline check')
openedAgain.props.onClick()
tree = await settle(props)

// the Agent changes it while another file is on screen
FILES['D:/proj/a.py'] = 'import re\n\ndef f(a):\n    return a + 99\n'
remoteVersion = 3
const otherFile = findClickable(tree, 'b.js')[0]
otherFile.props.onClick()
tree = await settle(props)

// returning finds the stored baseline, so the change is already visible
const backToA = findClickable(tree, 'a.py')[0]
backToA.props.onClick()
tree = await settle(props)
if (!findClickable(tree, '差异 •')[0]) throw new Error('returning to a changed file did not offer a diff')
const revisit = flatText(tree)
if (revisit.includes('两边内容相同')) throw new Error('revisit compared against the wrong baseline')

// ── a save that would overwrite unseen work: refuse, then diff ────────────
// Pin the target file: earlier steps may have left another one open.
const openForConflict = findClickable(tree, 'b.js')[0]
if (!openForConflict) throw new Error('b.js is not reachable for the conflict case')
openForConflict.props.onClick()
tree = await settle(props)

const editAgain = findClickable(tree, '编辑')[0]
if (!editAgain) throw new Error('no edit button for the conflict case')
editAgain.props.onClick()
tree = await settle(props)

const conflictArea = findTag(tree, 'textarea')[0]
if (!conflictArea) throw new Error('edit mode did not open for the conflict case')
conflictArea.props.onChange({ target: { value: 'my hand edit\n' } })

// the Agent writes between "open for editing" and "save"
FILES['D:/proj/sub/b.js'] = 'agent wrote this\n'
contentVersion = 'moved-under-us'
tree = await settle(props)

const saveAgain = findClickable(tree, '保存')[0]
if (!saveAgain) throw new Error('no save button for the conflict case')
saveAgain.props.onClick()
tree = await settle(props)

const conflictDump = texts(tree).join('|')
if (!conflictDump.includes('保存冲突')) throw new Error(`conflict was not surfaced: ${conflictDump.slice(0, 400)}`)
if (!conflictDump.includes('未覆盖')) throw new Error('conflict banner did not state that nothing was overwritten')
if (FILES['D:/proj/sub/b.js'] !== 'agent wrote this\n') throw new Error('a refused save still wrote the file')
if (!findTag(tree, 'textarea')[0]) throw new Error('a refused save must keep the draft open')

// the conflict offers a real diff, not just two choices
const conflictDiffBtn = findClickable(tree, '看差异')[0]
if (!conflictDiffBtn) throw new Error('conflict did not offer a diff')
conflictDiffBtn.props.onClick()
tree = await settle(props)
const conflictRows = texts(tree)
if (!conflictRows.includes('草稿 vs 磁盘')) throw new Error('conflict diff drawer did not open')
if (!conflictRows.includes('my hand edit')) throw new Error('conflict diff did not show the draft side')
if (!conflictRows.includes('agent wrote this')) throw new Error('conflict diff did not show the disk side')

// taking the disk version replaces the draft and clears the banner
const takeDisk = findClickable(tree, '载入新版本')[0]
if (!takeDisk) throw new Error('no load-new-version action')
takeDisk.props.onClick()
tree = await settle(props)
const afterDisk = findTag(tree, 'textarea')[0]
if (!afterDisk) throw new Error('loading the disk version closed edit mode')
if (afterDisk.props.value !== 'agent wrote this\n') throw new Error(`draft was not replaced: ${JSON.stringify(afterDisk.props.value)}`)
if (texts(tree).join('|').includes('保存冲突')) throw new Error('conflict banner survived the disk reload')

const cancelEdit = findClickable(tree, '取消')[0]
if (cancelEdit) cancelEdit.props.onClick()
tree = await settle(props)

// ── the poll survives a broken first-party stat ───────────────────────────
// A remote that throws must not leave the pane frozen; the host probe has to
// take over, otherwise an Agent edit silently never appears.
const statCallsBefore = hostCalls.filter((entry) => entry.url.endsWith('/stat')).length
remote.workspaceFiles.stat = async () => {
  throw new Error('remote stat unavailable')
}
const reopenForPoll = findClickable(tree, 'b.js')[0]
if (!reopenForPoll) throw new Error('b.js is not reachable for the poll case')
reopenForPoll.props.onClick()
tree = await settle(props)

const tick = intervals[intervals.length - 1]
if (typeof tick !== 'function') throw new Error('no poll interval for the fallback case')

// First tick adopts the host probe without claiming a change.
tick()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle(props)
if (texts(tree).join('|').includes('文件已更新')) {
  throw new Error('adopting the host probe must not be reported as an edit')
}

// Second tick sees a different hash and reports it.
contentVersion = 'changed-by-agent'
tick()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle(props)
const polled = texts(tree).join('|')
if (!polled.includes('文件已更新')) throw new Error(`fallback poll did not notice the change: ${polled.slice(0, 300)}`)
const statCallsAfter = hostCalls.filter((entry) => entry.url.endsWith('/stat')).length
if (statCallsAfter <= statCallsBefore) throw new Error('the fallback poll never reached the host stat route')

// ── session versions: tree marker and per-edit diff ───────────────────────
tree = await settle(props)
const marked = findClickable(tree, 'a.py')[0]
if (!marked) throw new Error('a.py is not reachable for the marker check')
if (!flatText(marked).includes('●')) throw new Error('a file the Agent edited carries no marker')

const markedDir = findClickable(tree, 'sub')[0]
if (!markedDir) throw new Error('sub is not reachable for the directory marker')
if (!flatText(markedDir).includes('●')) throw new Error('a directory holding an edited file carries no marker')

marked.props.onClick()
tree = await settle(props)
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle(props)

const currentChip = findClickable(tree, '当前内容')[0]
if (!currentChip) throw new Error(`the version strip did not appear: ${flatText(tree).slice(0, 400)}`)
const firstChip = findClickable(tree, '1 ·')[0]
if (!firstChip) throw new Error('no per-edit chip for the recorded replacement edit')

firstChip.props.onClick()
tree = await settle(props)
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle(props)
const picked = flatText(tree)
if (!picked.includes('return a + 2')) throw new Error(`picked edit did not render the new text: ${picked.slice(0, 400)}`)
if (!picked.includes('return a + 1')) throw new Error('picked edit did not render the removed text')

// a whole-file write has no recorded before text: say so instead of faking it
const secondChip = findClickable(tree, '2 ·')[0]
if (!secondChip) throw new Error('no chip for the recorded write')
secondChip.props.onClick()
tree = await settle(props)
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle(props)
const wrote = flatText(tree)
if (!wrote.includes('整体写入')) throw new Error('a whole-file write did not explain the missing before text')
if (!wrote.includes('brand new')) throw new Error('the written content did not render')

// going back to the file clears the picked edit
const backToCurrent = findClickable(tree, '当前内容')[0]
backToCurrent.props.onClick()
tree = await settle(props)
if (!flatText(tree).includes('def f')) throw new Error('returning to the current content did not show the file')
if (flatText(tree).includes('整体写入')) throw new Error('the picked edit survived the return to the file')

/** Labels of every version chip, in render order. */
function chipsOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) chipsOf(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.props && node.props['data-ide-chip'] !== undefined) out.push(flatText(node))
  for (const child of node.children || []) chipsOf(child, out)
  return out
}

// a file with a long edit history folds the older chips behind a count
const heavyRow = findClickable(tree, 'heavy.py')[0]
if (!heavyRow) throw new Error('heavy.py is not reachable for the folding check')
heavyRow.props.onClick()
tree = await settle(props)
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle(props)
const heavyChips = chipsOf(tree)
const numbered = heavyChips.filter((label) => /^\d+ ·/.test(label))
if (!heavyChips.includes('更早 3 条')) throw new Error(`15 edits did not fold: ${JSON.stringify(heavyChips)}`)
if (numbered.length !== 12) throw new Error(`expected 12 visible edit chips, got ${numbered.length}`)
if (!numbered[0].startsWith('4 ·')) throw new Error(`folding kept the wrong end: ${numbered[0]}`)

const expand = findClickable(tree, '更早 3 条')[0]
expand.props.onClick()
tree = await settle(props)
const expandedChips = chipsOf(tree).filter((label) => /^\d+ ·/.test(label))
if (expandedChips.length !== 15) throw new Error(`expanding did not reveal every edit: ${expandedChips.length}`)
if (!expandedChips[0].startsWith('1 ·')) throw new Error(`the oldest edit is not first after expanding: ${expandedChips[0]}`)

// ── a tab addressed at one file opens on it ───────────────────────────────
// This is what a chat file reference does: the tab carries the address, and the
// pane must land on that file without the user navigating the tree.
props.useTabInfo = () => ({ tab: { contentId: 'dsh-resource://file/session/s1/D:/proj/a.py' } })
tree = await settle(props)
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle(props)
const addressedDump = flatText(tree)
if (!addressedDump.includes('D:/proj/a.py')) throw new Error(`an addressed tab did not open its file: ${addressedDump.slice(0, 400)}`)
if (!addressedDump.includes('import re')) throw new Error('the addressed file was not read')
if (!calls.some(([kind, , target]) => kind === 'read' && target === 'D:/proj/a.py')) {
  throw new Error('the addressed tab never asked the remote for its file')
}

/** Find a tree row (not the breadcrumb) that carries a context menu. */
function findMenuTarget(node, name, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findMenuTarget(child, name, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (
    typeof node.props.onContextMenu === 'function' &&
    node.props['data-ide-row'] !== undefined &&
    flatText(node).includes(name)
  ) out.push(node)
  for (const child of node.children || []) findMenuTarget(child, name, out)
  return out
}

/** Find a menu button by its exact label, skipping the container. */
function findMenuButton(node, label, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findMenuButton(child, label, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.props.onClick === 'function' && flatText(node) === label) out.push(node)
  for (const child of node.children || []) findMenuButton(child, label, out)
  return out
}

// ── drag, copy, and the row menu ──────────────────────────────────────────
tree = await settle(props)
const menuRow = findMenuTarget(tree, 'a.py')[0]
if (!menuRow) throw new Error('a tree row carries no context menu')
if (menuRow.props.draggable !== true) throw new Error('a tree row is not draggable')

// Drag out: the payload is the reference syntax, not the bare path.
const dragData = new Map()
menuRow.props.onDragStart({
  dataTransfer: { setData: (type, value) => dragData.set(type, value), effectAllowed: '' },
})
if (dragData.get('text/plain') !== '@D:/proj/a.py') {
  throw new Error(`drag payload is wrong: ${JSON.stringify([...dragData])}`)
}

// Dropping it in the conversation inserts the reference through the composer.
inserted.length = 0
let prevented = false
dispatch('drop', {
  preventDefault: () => { prevented = true },
  stopPropagation: () => {},
  target: new FakeNode(),
})
await new Promise((resolve) => setTimeout(resolve, 0))
if (!prevented) throw new Error('the drop was not consumed, so the editor would insert it twice')
if (inserted.length !== 1 || inserted[0].text !== '@D:/proj/a.py ') {
  throw new Error(`drop did not reference the file: ${JSON.stringify(inserted)}`)
}

// The menu copies the path, copies the content, and references the file.
const reopenMenu = findMenuTarget(tree, 'a.py')[0]
reopenMenu.props.onContextMenu({ preventDefault: () => {}, stopPropagation: () => {}, clientX: 40, clientY: 60 })
tree = await settle(props)
for (const label of ['引用到对话', '复制路径', '复制内容']) {
  if (!findClickable(tree, label)[0]) throw new Error(`the row menu is missing "${label}"`)
}

copied.length = 0
findMenuButton(tree, '复制路径')[0].props.onClick({ stopPropagation: () => {} })
await new Promise((resolve) => setTimeout(resolve, 0))
if (copied[0] !== 'D:/proj/a.py') throw new Error(`copy path copied ${JSON.stringify(copied)}`)

tree = await settle(props)
findMenuTarget(tree, 'a.py')[0].props.onContextMenu({ preventDefault: () => {}, stopPropagation: () => {}, clientX: 40, clientY: 60 })
tree = await settle(props)
copied.length = 0
findMenuButton(tree, '复制内容')[0].props.onClick({ stopPropagation: () => {} })
await new Promise((resolve) => setTimeout(resolve, 0))
if (!String(copied[0]).includes('import re')) throw new Error(`copy content copied ${JSON.stringify(copied).slice(0, 200)}`)

tree = await settle(props)
findMenuTarget(tree, 'a.py')[0].props.onContextMenu({ preventDefault: () => {}, stopPropagation: () => {}, clientX: 40, clientY: 60 })
tree = await settle(props)
inserted.length = 0
findMenuButton(tree, '引用到对话')[0].props.onClick({ stopPropagation: () => {} })
await new Promise((resolve) => setTimeout(resolve, 0))
if (inserted[0].text !== '@D:/proj/a.py ') throw new Error(`menu reference inserted ${JSON.stringify(inserted)}`)

const runStreamClick = findClickable(tree, '▶ 运行')[0]
if (!runStreamClick) throw new Error('no run button for the streaming case')
await runStreamClick.props.onClick()
tree = await settle(props)

const streamDump = flatText(tree)
if (!streamDump.includes('first line')) throw new Error(`streamed output missing: ${streamDump.slice(-200)}`)
if (streamDump.includes('\u001b[')) throw new Error('escape sequences leaked into the view')
// The two writes onto one line must collapse to the last one.
if (streamDump.includes('progress 10%')) throw new Error('carriage returns were not folded')
if (!streamDump.includes('progress 90%')) throw new Error('the final progress line is missing')
if (!streamDump.includes('42ms')) throw new Error('the end frame did not report its duration')
// A finished run is not "running" any more.
if (flatText(tree).includes('● 运行中')) throw new Error('the button still reads as running after the end frame')

// ── stop closes the stream ────────────────────────────────────────────────
streamMode = 'never'
const runNever = findClickable(tree, '▶ 运行')[0]
void runNever.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
tree = await settle(props)
if (!flatText(tree).includes('● 运行中')) throw new Error('a live run must read as running')
const stopNow = findClickable(tree, '■ 停止')[0]
if (!stopNow) throw new Error('a live run offers no stop')
stopNow.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
tree = await settle(props)
if (flatText(tree).includes('● 运行中')) throw new Error('stop did not end the run')
if (!flatText(tree).includes('已停止')) throw new Error('stop did not report itself')

// ── markdown renders, and the source is one click away ────────────────────
tree = await settle(props)
const mdRow = findClickable(tree, 'notes.md')[0]
if (!mdRow) throw new Error('notes.md is not reachable')
mdRow.props.onClick()
tree = await settle(props)

/** Collect every element of one tag in the rendered document. */
const tags = (node, tag, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) tags(child, tag, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.type === tag) out.push(node)
  for (const child of node.children || []) tags(child, tag, out)
  return out
}

const mdDump = flatText(tree)
if (mdDump.includes('## 表格')) throw new Error('markdown source leaked into the rendered view')
if (tags(tree, 'h1').length === 0) throw new Error('no h1 rendered')
if (tags(tree, 'h2').length === 0) throw new Error('no h2 rendered')
if (tags(tree, 'strong').length === 0) throw new Error('bold text did not render')
if (tags(tree, 'code').length === 0) throw new Error('inline code did not render')
if (tags(tree, 'table').length !== 1) throw new Error(`table did not render: ${tags(tree, 'table').length}`)
if (tags(tree, 'th').length !== 2) throw new Error('table header cells missing')
if (tags(tree, 'td').length !== 4) throw new Error('table body cells missing')
if (tags(tree, 'blockquote').length === 0) throw new Error('blockquote did not render')
if (tags(tree, 'li').length < 4) throw new Error('list items did not render')
const fence = tags(tree, 'pre').find((node) => flatText(node).includes('fenced'))
if (!fence) throw new Error('fenced code block did not render')
const link = tags(tree, 'a')[0]
if (!link || link.props.href !== 'https://example.com') throw new Error('link did not render')
if (link.props.target !== '_blank') throw new Error('a rendered link must open outside the app')

// Task-list boxes and the rule are plain divs; check their glyphs.
if (!mdDump.includes('☑')) throw new Error('a checked task item lost its box')
if (!mdDump.includes('☐')) throw new Error('an unchecked task item lost its box')

// Inline and display math.
if (mdDump.includes('$\\sim10^{-3}$')) throw new Error(`inline math was left as source: ${mdDump.slice(0, 300)}`)
if (!mdDump.includes('∼')) throw new Error('\\sim did not render')
if (!mdDump.includes('10')) throw new Error('the mantissa of the inline formula went missing')
const sups = tags(tree, 'sup')
if (sups.length === 0) throw new Error('no superscript rendered for 10^{-3}')
if (flatText(sups[0]) !== '-3') throw new Error(`superscript reads ${flatText(sups[0])}`)
if (!mdDump.includes('a/b')) throw new Error('\\frac did not render as a ratio')
if (mdDump.includes('\\sum')) throw new Error('display math was left as source')
if (!mdDump.includes('∑')) throw new Error('\\sum did not render')
if (!mdDump.includes('≈') || !mdDump.includes('∞')) throw new Error('display math symbols went missing')
const subTexts = tags(tree, 'sub').map((node) => flatText(node))
if (!subTexts.includes('i=1')) throw new Error(`display-math subscript is wrong: ${JSON.stringify(subTexts)}`)

// Money is not a formula.
if (!mdDump.includes('$5 和 $10')) throw new Error(`a price was rendered as math: ${mdDump.slice(0, 300)}`)

// Accents, fences and spacing.
if (mdDump.includes('\\hat')) throw new Error('\\hat was left as a raw command')
if (!mdDump.includes('y\u0302')) throw new Error('\\hat{y} lost its combining circumflex')
if (mdDump.includes('\\left') || mdDump.includes('\\right')) throw new Error('\\left/\\right were left as commands')
if (!mdDump.includes('( a+b )')) throw new Error('the fences did not survive')
if (mdDump.includes('a,b')) throw new Error('\\, became a comma instead of a thin space')

// A stray dollar before a formula must not swallow it.
if (!mdDump.includes('成本 $8')) throw new Error(`a price was eaten by the next formula: ${mdDump.slice(0, 300)}`)
if (!mdDump.includes('r\u0302=8')) throw new Error('\\hat r=8 did not render next to a price')
if (!mdDump.includes('k\u0302=2')) throw new Error('the formula after a price did not render')

// A paragraph that mixes escaped markdown, a relation symbol, plain formulas
// and bold spanning a formula.
if (mdDump.includes('\\#2')) throw new Error('an escaped hash was left as a raw escape')
if (!mdDump.includes('#2 锁在一起')) throw new Error('the escaped hash did not become text')
if (mdDump.includes('\\gtrsim')) throw new Error('\\gtrsim was left as a raw command')
if (!mdDump.includes('≳')) throw new Error('\\gtrsim did not render')
if (!mdDump.includes('r=768')) throw new Error('$r=768$ did not render')
if (!mdDump.includes('在 768 维')) throw new Error('$768$ did not render')
const boldWithMath = tags(tree, 'strong').map((node) => flatText(node)).find((text) => text.includes('768'))
if (!boldWithMath) {
  throw new Error(`bold did not survive a formula inside it: ${JSON.stringify(tags(tree, 'strong').map(flatText))}`)
}

const toSource = findClickable(tree, '源码')[0]
if (!toSource) throw new Error('no source toggle for a markdown file')
toSource.props.onClick()
tree = await settle(props)
if (!flatText(tree).includes('## 表格')) throw new Error('the source view did not show the raw markdown')
const toPreview = findClickable(tree, '预览')[0]
if (!toPreview) throw new Error('no way back to the rendered view')
toPreview.props.onClick()
tree = await settle(props)
if (tags(tree, 'table').length !== 1) throw new Error('the rendered view did not come back')

console.log('ok: tree → file → colourisation → reference → versioned save → run → agent diff → conflict diff → poll fallback → session versions → drag/copy/menu → streaming run → stop → markdown')
console.log('calls: %s', calls.map((entry) => entry[0] + ':' + entry[2]).join(', '))

