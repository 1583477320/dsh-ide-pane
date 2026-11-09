/**
 * Host route test: mount the real handler on a throwaway HTTP server and drive
 * it over the wire, exactly like the browser will.
 *
 *   node test/host.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const root = await mkdtemp(join(tmpdir(), 'ide-pane-'))

// ── a fake session log carrying real tool-call shapes ──────────────────────
const EVENTS = [
  {
    seq: 1,
    type: 'tool/call',
    time: 1000,
    data: { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.py', old_string: 'one\ntwo', new_string: 'one\nTWO' }) },
  },
  {
    seq: 2,
    type: 'tool/call',
    time: 1500,
    // A read names a path too, but writes nothing: it must not appear.
    data: { callId: 'c2', name: 'read', arguments: JSON.stringify({ path: 'a.py' }) },
  },
  {
    seq: 3,
    type: 'tool/call',
    time: 2000,
    data: { callId: 'c3', name: 'write', arguments: JSON.stringify({ file_path: 'b.py', content: 'hello\n' }) },
  },
  {
    seq: 4,
    type: 'tool/call',
    time: 3000,
    // The alternate spelling of a replacement edit.
    data: { callId: 'c4', name: 'str_replace_editor', arguments: JSON.stringify({ path: 'a.py', old_str: 'x', new_str: 'y' }) },
  },
  { seq: 5, type: 'assistant/message', time: 3500, data: { message: {} } },
]
const session = {
  seq: 5,
  snapshotEvents: (from = 0, to) => EVENTS.filter((event) => event.seq >= from && (to === undefined || event.seq < to)),
  eventAt: (seq) => EVENTS.find((event) => event.seq === seq),
}

let handler
const ctx = {
  effect: (fn) => {
    fn()
    return () => {}
  },
  inject: (names, cb) => {
    cb({ ...ctx, sessions: { get: (id) => (id === 'live' ? session : undefined) } })
  },
  webServer: {
    register(route) {
      assert.equal(route.kind, 'prefix')
      assert.equal(route.path, '/dsh-ide-pane')
      handler = route.handler
      return () => {}
    },
  },
}

apply(ctx, {})
assert.equal(typeof handler, 'function', 'apply() did not register a route')

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

/** POST JSON through the guard header. */
async function post(action, body, { header = true } = {}) {
  const response = await fetch(`${origin}/dsh-ide-pane/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(header ? { 'x-dsh-ide-pane': '1' } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

// write
const target = join(root, 'probe.txt')
const written = await post('write', { root, path: 'probe.txt', text: 'hello 世界\n' })
assert.equal(written.status, 200, `write failed: ${JSON.stringify(written.json)}`)
assert.equal(written.json.ok, true)
assert.equal(await readFile(target, 'utf8'), 'hello 世界\n')

// stat: missing, then present, with a version that changes with content
const missing = await post('stat', { root, path: 'probe.txt' })
assert.equal(missing.json.exists, true)
const v1 = missing.json.version
assert.equal(typeof v1, 'string')
const absent = await post('stat', { root, path: 'nope.txt' })
assert.equal(absent.json.exists, false)
assert.equal(absent.json.version, null)

// conflict: saving on top of a version the caller never saw is refused
const stale = await post('write', { root, path: 'probe.txt', text: 'clobbered\n', baseVersion: 'deadbeefdeadbeef' })
assert.equal(stale.json.ok, false)
assert.equal(stale.json.conflict, true)
assert.equal(stale.json.currentText, 'hello 世界\n', 'conflict must hand back the disk text')
assert.equal(await readFile(target, 'utf8'), 'hello 世界\n', 'a refused save must not touch the file')

// and the reverse: a matching base version writes, and reports the new one
const fresh = await post('write', { root, path: 'probe.txt', text: 'hello 世界\nmore\n', baseVersion: v1 })
assert.equal(fresh.json.ok, true, `fresh write failed: ${JSON.stringify(fresh.json)}`)
assert.equal(typeof fresh.json.version, 'string')
assert.notEqual(fresh.json.version, v1)
assert.equal(await readFile(target, 'utf8'), 'hello 世界\nmore\n')

// creating a file that did not exist uses baseVersion null
const created = await post('write', { root, path: 'brand-new.txt', text: 'x\n', baseVersion: null })
assert.equal(created.json.ok, true)
const race = await post('write', { root, path: 'brand-new.txt', text: 'y\n', baseVersion: null })
assert.equal(race.json.conflict, true, 'null base on an existing file must conflict')

// run: a real node script
const script = join(root, 'run.mjs')
await writeFile(script, "console.log('out-ok'); console.error('err-ok'); process.exit(0)\n", 'utf8')
const ran = await post('run', { root, path: 'run.mjs' })
assert.equal(ran.status, 200)
assert.equal(ran.json.ok, true, `run failed: ${JSON.stringify(ran.json)}`)
assert.match(ran.json.stdout, /out-ok/)
assert.match(ran.json.stderr, /err-ok/)
assert.equal(ran.json.code, 0)
assert.ok(ran.json.ms >= 0)

// failing run still answers, with a non-zero code
const boom = join(root, 'boom.mjs')
await writeFile(boom, "console.error('nope'); process.exit(3)\n", 'utf8')
const failed = await post('run', { root, path: 'boom.mjs' })
assert.equal(failed.json.ok, false)
assert.equal(failed.json.code, 3)

// non-ASCII output survives the pipe: the run route forces a UTF-8 child and
// decodes with a streaming decoder, so no character may be mangled at a chunk
// boundary.
const wide = join(root, 'wide.mjs')
await writeFile(wide, "process.stdout.write('中文输出 ✓ 一整个字符串'.repeat(4000))\n", 'utf8')
const wideRun = await post('run', { root, path: 'wide.mjs' })
assert.equal(wideRun.json.ok, true, `wide run failed: ${JSON.stringify(wideRun.json).slice(0, 200)}`)
assert.equal(wideRun.json.stdout.includes('\uFFFD'), false, 'a character was corrupted by chunk decoding')
assert.equal(wideRun.json.stdout.startsWith('中文输出 ✓ 一整个字符串'), true, 'leading text was corrupted')
assert.equal(wideRun.json.stdout.endsWith('一整个字符串'), true, 'trailing text was corrupted')

// guard: no header
const noHeader = await post('write', { root, path: 'sneaky.txt', text: 'x' }, { header: false })
assert.equal(noHeader.status, 403)

// containment: escape the root
const escape = await post('write', { root, path: '../escape.txt', text: 'x' })
assert.equal(escape.status, 500)
assert.match(String(escape.json.error), /越出工作区/)

// absolute path outside the root
const absolute = await post('write', { root, path: join(tmpdir(), 'outside.txt'), text: 'x' })
assert.equal(absolute.status, 500)

// unknown action
const unknown = await post('nope', {})
assert.equal(unknown.status, 404)

// ping
const ping = await post('ping', {})
assert.equal(ping.json.ok, true)

// activity was removed with the trace view: it must not linger as a route
const removed = await post('activity', { sessionId: 's1' })
assert.equal(removed.status, 404)
assert.match(String(removed.json.error), /未知动作/)

// ── edits: per-file summary from the session log ──────────────────────────
const edits = await post('edits', { sessionId: 'live' })
assert.equal(edits.json.ok, true, `edits failed: ${JSON.stringify(edits.json)}`)
assert.equal(edits.json.seq, 5)
const aEdits = edits.json.files['a.py']
assert.ok(Array.isArray(aEdits), `a.py missing from the summary: ${JSON.stringify(Object.keys(edits.json.files))}`)
assert.equal(aEdits.length, 2, 'a read must not be counted as an edit')
assert.equal(aEdits[0].kind, 'replace')
assert.equal(aEdits[0].oldLines, 2)
assert.equal(aEdits[0].newLines, 2)
assert.equal(aEdits[1].tool, 'str_replace_editor', 'the alt spelling must be recognised')
assert.equal(edits.json.files['b.py'][0].kind, 'write')
assert.equal(edits.json.files['b.py'][0].oldLines, null, 'a whole-file write has no recorded before text')

// the summary must stay cheap: no file content in it
const summaryJson = JSON.stringify(edits.json)
assert.equal(summaryJson.includes('one\\ntwo'), false, 'the summary leaked edit text')

// ── editText: materialise one call on demand ──────────────────────────────
const detail = await post('editText', { sessionId: 'live', seq: 1 })
assert.equal(detail.json.ok, true, `editText failed: ${JSON.stringify(detail.json)}`)
assert.equal(detail.json.old, 'one\ntwo')
assert.equal(detail.json.new, 'one\nTWO')
assert.equal(detail.json.path, 'a.py')

const viaAlt = await post('editText', { sessionId: 'live', seq: 4 })
assert.equal(viaAlt.json.new, 'y', 'the alt spelling must yield text too')

const notAnEdit = await post('editText', { sessionId: 'live', seq: 2 })
assert.equal(notAnEdit.json.ok, false)
assert.match(String(notAnEdit.json.error), /文件改动/)

const missingSeq = await post('editText', { sessionId: 'live' })
assert.equal(missingSeq.json.ok, false)
assert.match(String(missingSeq.json.error), /seq/)

const noSession = await post('edits', { sessionId: 'ghost' })
assert.equal(noSession.json.ok, false)
assert.match(String(noSession.json.error), /不在线/)

// ── the summary folds only the new tail ───────────────────────────────────
// Same watermark: the cached answer is returned unchanged.
const again = await post('edits', { sessionId: 'live' })
assert.equal(again.json.files['a.py'].length, 2, 'a cached read must not double-count')

// One new edit arrives; only it should be appended.
EVENTS.push({
  seq: 6,
  type: 'tool/call',
  time: 4000,
  data: { callId: 'c5', name: 'edit', arguments: JSON.stringify({ file_path: 'a.py', old_string: 'p', new_string: 'q' }) },
})
session.seq = 6
const grown = await post('edits', { sessionId: 'live' })
assert.equal(grown.json.seq, 6)
assert.equal(grown.json.files['a.py'].length, 3, 'the incremental fold lost or duplicated an edit')
assert.equal(grown.json.files['a.py'][2].seq, 6)

// ── streaming run: frames arrive before the process ends ─────────────────
const streamer = join(root, 'slow.mjs')
await writeFile(
  streamer,
  "console.log('first'); setTimeout(() => { console.log('second'); process.exit(0) }, 300)\n",
  'utf8',
)

const streamStarted = Date.now()
const streamResponse = await fetch(`${origin}/dsh-ide-pane/runStream`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-ide-pane': '1' },
  body: JSON.stringify({ root, path: 'slow.mjs' }),
})
assert.equal(streamResponse.status, 200)
assert.match(String(streamResponse.headers.get('content-type')), /text\/event-stream/)

const reader = streamResponse.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const frames = []
let firstOutAt = null
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  let cut = buffer.indexOf('\n\n')
  while (cut !== -1) {
    const raw = buffer.slice(0, cut)
    buffer = buffer.slice(cut + 2)
    if (raw.startsWith('data: ')) {
      const frame = JSON.parse(raw.slice(6))
      frames.push(frame)
      if (frame.type === 'out' && firstOutAt === null) firstOutAt = Date.now() - streamStarted
    }
    cut = buffer.indexOf('\n\n')
  }
}

const totalAt = Date.now() - streamStarted
assert.equal(frames[0].type, 'start', `first frame should be start: ${JSON.stringify(frames[0])}`)
assert.match(String(frames[0].command), /node/)
const outText = frames.filter((frame) => frame.type === 'out').map((frame) => frame.text).join('')
assert.match(outText, /first/)
assert.match(outText, /second/)
const endFrame = frames.find((frame) => frame.type === 'end')
assert.ok(endFrame, 'the stream never reported an end frame')
assert.equal(endFrame.code, 0)
assert.ok(firstOutAt !== null, 'no output frame arrived')
assert.ok(
  firstOutAt < totalAt - 100,
  `output was not streamed: first frame at ${firstOutAt}ms, end at ${totalAt}ms`,
)

// A cancelled stream must not leave the child running.
const hanging = join(root, 'hang.mjs')
await writeFile(hanging, "setInterval(() => console.log('tick'), 100)\n", 'utf8')
const abortController = new AbortController()
const cancelled = await fetch(`${origin}/dsh-ide-pane/runStream`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-ide-pane': '1' },
  body: JSON.stringify({ root, path: 'hang.mjs' }),
  signal: abortController.signal,
})
const cancelReader = cancelled.body.getReader()
await cancelReader.read()
abortController.abort()
// The Host kills on the response closing; nothing may reject out of it.
await new Promise((resolve) => setTimeout(resolve, 200))

await new Promise((resolve) => server.close(resolve))
await rm(root, { recursive: true, force: true })

console.log('ok: write → run → guard → containment')
