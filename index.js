/**
 * Host half of dsh-ide-pane.
 *
 * The pane reads files through the first-party `remote.workspaceFiles`
 * namespace, so reading needs nothing here. Writing and running do not exist on
 * that namespace, so this half owns three narrow, localhost-only endpoints:
 *
 *   POST /dsh-ide-pane/stat      { root, path }                   → { exists, version }
 *   POST /dsh-ide-pane/write     { root, path, text, baseVersion? } → { bytes }
 *   POST /dsh-ide-pane/run       { root, path, command? }         → { code, stdout, stderr, ms }
 *
 * Plus two read-only endpoints that expose what the Agent changed in this
 * Session, taken from the committed event log:
 *
 *   POST /dsh-ide-pane/edits     { sessionId }                    → { files: { path: [edit] } }
 *   POST /dsh-ide-pane/editText  { sessionId, seq }               → { old, new }
 *
 * The summary never carries file content, so the tree can poll it cheaply; the
 * text is materialised from one event only when a diff is actually opened.
 *
 * Every filesystem path is resolved against a caller-supplied `root` and
 * refused when it escapes. The root is the session working directory the
 * browser already displays; a cross-origin page cannot use these routes because
 * they require a custom header (which forces a preflight this server never
 * answers).
 */
import { writeFile, stat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { resolve, sep, isAbsolute, basename, dirname } from 'node:path'

/** Route prefix owned by this plugin. */
const PREFIX = '/dsh-ide-pane'

/** Largest request body accepted, in bytes. */
const MAX_BODY = 8 * 1024 * 1024

/** Longest a run may take before it is killed, in ms. */
const RUN_TIMEOUT_MS = 120000

/** Captured output cap per stream, in bytes. */
const MAX_OUTPUT = 256 * 1024

/** Most tool calls summarised per session. */
const MAX_EDITS = 400

/** Most sessions whose summary is cached. */
const MAX_CACHED_SESSIONS = 8

/** Longest single edit body handed to the browser, in characters. */
const MAX_EDIT_TEXT = 200000

/** Tool names whose arguments may carry file content. */
const WRITE_TOOLS = new Set([
  'edit',
  'write',
  'str_replace_editor',
  'str-replace-editor',
  'multi_edit',
  'apply_patch',
  'create_file',
  'fs_write',
])

/** Cordis service dependency: routes are registered on the web server. */
export const inject = ['webServer']

/**
 * @param ctx - the Host plugin context.
 * @param config - the row's raw config; `{ enabled: false }` keeps it dormant.
 */
export function apply(ctx, config) {
  const options = config && typeof config === 'object' ? config : {}
  if (options.enabled === false) return

  // A plugin fiber may only touch services it declared, so `sessions` is
  // requested separately and the routes read it through this handle.
  const host = { sessions: null }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => route(req, res, host),
      }),
    'dsh-ide-pane: routes',
  )

  ctx.inject(['sessions'], (inner) => {
    host.sessions = inner.sessions
  })
}

/**
 * Dispatch one request.
 * @param req - node request.
 * @param res - node response.
 */
async function route(req, res, host) {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!guard(req, res)) return

    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: '请用 POST' })
      return
    }

    const body = await readJson(req)
    const action = url.pathname.slice(PREFIX.length + 1)
    if (action === 'stat') {
      await handleStat(body, res)
      return
    }
    if (action === 'write') {
      await handleWrite(body, res)
      return
    }
    if (action === 'run') {
      await handleRun(body, res)
      return
    }
    if (action === 'runStream') {
      await handleRunStream(body, req, res)
      return
    }
    if (action === 'edits') {
      send(res, 200, handleEdits(host, body))
      return
    }
    if (action === 'editText') {
      send(res, 200, handleEditText(host, body))
      return
    }
    if (action === 'ping') {
      send(res, 200, { ok: true, pid: process.pid })
      return
    }
    send(res, 404, { ok: false, error: `未知动作 ${action}` })
  } catch (error) {
    send(res, 500, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * Reject cross-origin callers and anything without the plugin header.
 * A custom header makes a cross-origin call a preflight, and this server never
 * answers one, so a page on another origin cannot reach these routes.
 * @returns whether the request may proceed.
 */
function guard(req, res) {
  if (req.headers['x-dsh-ide-pane'] !== '1') {
    send(res, 403, { ok: false, error: '缺少 x-dsh-ide-pane 头' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = ''
    }
    if (originHost !== req.headers.host) {
      send(res, 403, { ok: false, error: `来源被拒绝：${origin}` })
      return false
    }
  }
  return true
}

/**
 * Read and parse a JSON body with a size cap.
 * @param req - node request.
 */
function readJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        rejectBody(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    req.on('error', rejectBody)
  })
}

/**
 * Resolve `path` inside `root`, refusing escapes.
 * @param root - absolute directory the pane is scoped to.
 * @param path - relative or absolute target.
 * @returns the absolute target.
 */
function containedPath(root, path) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('root 必须是绝对路径')
  if (typeof path !== 'string' || path === '') throw new Error('path 不能为空')
  const base = resolve(root)
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path)
  if (target !== base && !target.startsWith(base + sep)) throw new Error('路径越出工作区')
  return target
}

/**
 * Parsed `arguments` of a tool call, as an object.
 *
 * The log stores them as JSON text, but a backend may hand over an object; both
 * shapes reach the same extractor.
 */
function argumentsOf(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Describe one file-writing tool call, or `null` when the call wrote nothing.
 *
 * Two shapes are recognised: a literal replacement (`old_string`/`new_string`,
 * and the `old_str`/`new_str` spelling) and a whole-file write (`content`). A
 * tool that names a file but carries neither is reported as `touch`, which is
 * still enough to mark the file as changed in the tree.
 */
function editFromEvent(event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return null
  const args = argumentsOf(data.arguments)
  if (!args) return null

  const target = [args.file_path, args.filePath, args.path, args.notebook_path]
    .find((value) => typeof value === 'string' && value !== '')
  if (target === undefined) return null

  const name = typeof data.name === 'string' ? data.name : ''
  const oldText = typeof args.old_string === 'string'
    ? args.old_string
    : typeof args.old_str === 'string'
      ? args.old_str
      : null
  const newText = typeof args.new_string === 'string'
    ? args.new_string
    : typeof args.new_str === 'string'
      ? args.new_str
      : null
  const content = typeof args.content === 'string'
    ? args.content
    : name !== 'edit' && WRITE_TOOLS.has(name) && typeof args.text === 'string'
      ? args.text
      : null

  if (oldText !== null || newText !== null) {
    return { path: target, tool: name, kind: 'replace', old: oldText, new: newText }
  }
  if (content !== null) {
    return { path: target, tool: name, kind: 'write', old: null, new: content }
  }
  if (WRITE_TOOLS.has(name)) {
    return { path: target, tool: name, kind: 'touch', old: null, new: null }
  }
  return null
}

/** Cached summaries, keyed by session id; value carries the log watermark. */
const editCache = new Map()

/**
 * Summarise every file-writing call in a Session, newest last.
 *
 * The result deliberately carries no file text: the tree polls this, and the
 * body of an edit is materialised from one event only when a diff is opened.
 * @returns `{ path: [{ seq, at, tool, kind, oldLines, newLines }] }`
 */
function summarizeEdits(sessionId, session) {
  const seq = typeof session.seq === 'number' ? session.seq : 0
  const cached = editCache.get(sessionId)
  if (cached && cached.seq === seq) return cached.files

  // Fold only the tail that arrived since the last read. A fork or a reset
  // moves the watermark backwards, which forces a full rescan.
  const incremental = cached !== undefined && seq > cached.seq
  const files = incremental ? cached.files : {}
  let lastSeq = incremental ? cached.lastSeq : -1
  let total = 0
  if (incremental) {
    for (const list of Object.values(files)) total += list.length
  }

  // The lower bound is inclusive, so re-reading the last folded event is
  // filtered out by `event.seq < from` instead of relying on the interval's
  // spelling of "next".
  const from = lastSeq + 1
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(from > 0 ? from : 0) : []
  for (const event of events) {
    if (!event || typeof event.seq !== 'number') continue
    if (event.seq < from) continue
    if (event.seq > lastSeq) lastSeq = event.seq
    if (event.type !== 'tool/call') continue
    const edit = editFromEvent(event)
    if (!edit) continue
    if (total >= MAX_EDITS) continue
    const list = files[edit.path] || (files[edit.path] = [])
    list.push({
      seq: event.seq,
      at: typeof event.time === 'number' ? event.time : 0,
      tool: edit.tool,
      kind: edit.kind,
      oldLines: edit.old === null ? null : edit.old.split('\n').length,
      newLines: edit.new === null ? null : edit.new.split('\n').length,
    })
    total += 1
  }

  editCache.set(sessionId, { seq, lastSeq, files })
  // A long-lived Host sees many sessions; keep the cache bounded.
  while (editCache.size > MAX_CACHED_SESSIONS) {
    const oldest = editCache.keys().next().value
    editCache.delete(oldest)
  }
  return files
}

/** Look up a live session for these routes, or a readable reason. */
function sessionFor(host, sessionId) {
  if (!sessionId) return { error: '缺少 sessionId' }
  const sessions = host && host.sessions
  if (!sessions || typeof sessions.get !== 'function') return { error: '宿主没有 sessions' }
  const session = sessions.get(sessionId)
  if (!session) return { error: '会话不在线' }
  return { session }
}

/** `edits`: per-file summary of what the Agent changed in this Session. */
function handleEdits(host, body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const found = sessionFor(host, sessionId)
  if (found.error) return { ok: false, files: {}, error: found.error }
  try {
    return { ok: true, seq: found.session.seq, files: summarizeEdits(sessionId, found.session) }
  } catch (error) {
    return { ok: false, files: {}, error: `读取会话日志失败：${String((error && error.message) || error)}` }
  }
}

/** `editText`: the before/after text of one recorded call. */
function handleEditText(host, body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const found = sessionFor(host, sessionId)
  if (found.error) return { ok: false, error: found.error }
  const seq = typeof body.seq === 'number' ? body.seq : Number(body.seq)
  if (!Number.isFinite(seq)) return { ok: false, error: '缺少 seq' }

  let event
  try {
    event = found.session.eventAt(seq)
  } catch (error) {
    return { ok: false, error: `读取事件失败：${String((error && error.message) || error)}` }
  }
  if (!event) return { ok: false, error: '事件不存在' }

  const edit = editFromEvent(event)
  if (!edit) return { ok: false, error: '这不是一次文件改动' }

  const clip = (value) => {
    if (typeof value !== 'string') return null
    return value.length <= MAX_EDIT_TEXT ? value : `${value.slice(0, MAX_EDIT_TEXT)}\n…（已截断）`
  }
  return { ok: true, kind: edit.kind, tool: edit.tool, path: edit.path, old: clip(edit.old), new: clip(edit.new) }
}

/**
 * Content-derived version of a file.
 *
 * The first-party `stat` reports a version the browser can compare, but the
 * Host cannot reproduce it, so the pane keeps its own content hash on both
 * sides: the same function decides "unchanged" before a save overwrites work
 * the Agent did in the meantime.
 * @param text - file contents.
 * @returns a short stable hash.
 */
function hashText(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Report whether a file exists and its content version.
 * @param body - `{ root, path }`.
 * @param res - node response.
 */
async function handleStat(body, res) {
  const target = containedPath(body.root, body.path)
  try {
    const text = await readFile(target, 'utf8')
    send(res, 200, { ok: true, exists: true, version: hashText(text), bytes: Buffer.byteLength(text, 'utf8') })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      send(res, 200, { ok: true, exists: false, version: null, bytes: 0 })
      return
    }
    send(res, 200, { ok: false, exists: false, error: String((error && error.message) || error) })
  }
}

/**
 * Write one file, refusing to overwrite a version the caller never saw.
 * @param body - `{ root, path, text, baseVersion? }`.
 * @param res - node response.
 */
async function handleWrite(body, res) {
  const target = containedPath(body.root, body.path)
  const text = typeof body.text === 'string' ? body.text : ''

  // A caller that names a base version gets conflict detection. `null` means
  // "the file did not exist when I opened it".
  if (body.baseVersion !== undefined) {
    let current = null
    let exists = false
    try {
      current = hashText(await readFile(target, 'utf8'))
      exists = true
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        send(res, 200, { ok: false, error: String((error && error.message) || error) })
        return
      }
    }
    const expected = body.baseVersion === null ? null : String(body.baseVersion)
    const actual = exists ? current : null
    if (expected !== actual) {
      // Hand back what is on disk so the browser can show the difference.
      const diskText = exists ? await readFile(target, 'utf8') : ''
      send(res, 200, {
        ok: false,
        conflict: true,
        error: '文件已被改动',
        currentVersion: actual,
        currentText: diskText,
      })
      return
    }
  }

  await writeFile(target, text, 'utf8')
  const info = await stat(target)
  send(res, 200, { ok: true, path: target, bytes: info.size, version: hashText(text) })
}

/**
 * Pick interpreter candidates for a file, or honour an explicit command.
 * The Host process PATH is not the user's interactive PATH, so a language that
 * works in a terminal may still be missing here: try the usual spellings in turn.
 * @param target - absolute file path.
 * @param command - optional explicit command line.
 * @returns candidate plans, most specific first.
 */
function planRun(target, command) {
  if (typeof command === 'string' && command.trim() !== '') {
    return [{ shell: true, cmd: command, args: [] }]
  }
  const ext = (basename(target).split('.').pop() || '').toLowerCase()
  if (ext === 'py' || ext === 'pyw') {
    return [
      { shell: false, cmd: 'python', args: [target] },
      { shell: false, cmd: 'py', args: ['-3', target] },
      { shell: false, cmd: 'python3', args: [target] },
    ]
  }
  if (['js', 'mjs', 'cjs'].includes(ext)) {
    return [{ shell: false, cmd: 'node', args: [target] }]
  }
  if (ext === 'ps1') {
    return [
      { shell: false, cmd: 'pwsh', args: ['-NoProfile', '-File', target] },
      { shell: false, cmd: 'powershell', args: ['-NoProfile', '-File', target] },
    ]
  }
  if (ext === 'sh') return [{ shell: false, cmd: 'bash', args: [target] }]
  return [{ shell: true, cmd: `echo 不支持的类型：${basename(target)}`, args: [] }]
}

/**
 * Spawn one plan and capture bounded output.
 * @param plan - interpreter candidate.
 * @param target - absolute file to run (its directory becomes the cwd).
 * @param started - epoch ms when the attempt began.
 * @returns the result, or `undefined` when the executable was not found.
 */
function tryPlan(plan, target, started) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(plan.cmd, plan.args, {
        cwd: dirname(target),
        shell: plan.shell,
        windowsHide: true,
        env: childEnv(),
      })
    } catch (error) {
      resolveRun(error && error.code === 'ENOENT' ? undefined : failure(error, started, plan))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    // A chunk boundary can fall inside a multi-byte character; decoding each
    // chunk on its own would corrupt it. StringDecoder holds the remainder.
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL')
    }, RUN_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += outDecoder.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += errDecoder.write(chunk)
    })

    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error && error.code === 'ENOENT') {
        resolveRun(undefined)
        return
      }
      resolveRun({
        ok: error === undefined && code === 0,
        code,
        stdout: (stdout + outDecoder.end()).slice(0, MAX_OUTPUT),
        stderr: (stderr + errDecoder.end() + (error ? String(error.message) : '')).slice(0, MAX_OUTPUT),
        ms: Date.now() - started,
        command: plan.shell ? plan.cmd : [plan.cmd, ...plan.args].join(' '),
      })
    }

    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code, undefined))
  })
}

/** Shape one spawn failure as a run result. */
function failure(error, started, plan) {
  return {
    ok: false,
    code: null,
    stdout: '',
    stderr: String((error && error.message) || error),
    ms: Date.now() - started,
    command: plan.shell ? plan.cmd : [plan.cmd, ...plan.args].join(' '),
  }
}

/**
 * Run one file, streaming output as it is produced.
 *
 * This is a plain `text/event-stream` over the plugin's own route, so nothing
 * depends on the Remote/gateway streaming layer: the browser reads the body
 * incrementally and the Host flushes each chunk. Closing the response kills the
 * child, which is what the Stop button does.
 *
 * Frames: `{type:'start',command}`, `{type:'out'|'err',text}`,
 * `{type:'end',code,ok,ms}` or `{type:'fail',error}`.
 * @param body - `{ root, path, command? }`.
 * @param req - node request, watched for the client hanging up.
 * @param res - node response.
 */
async function handleRunStream(body, req, res) {
  const target = containedPath(body.root, body.path)
  const plans = planRun(target, body.command)

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Proxies must not buffer a stream that exists to arrive early.
    'x-accel-buffering': 'no',
  })

  let closed = false
  const emit = (payload) => {
    if (closed) return
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  const finish = () => {
    if (closed) return
    closed = true
    res.end()
  }

  const started = Date.now()
  let child = null
  let done = false
  const stop = () => {
    // Fires both for a client hang-up and after a normal end; only the former
    // leaves a live child, and killing that is the point.
    if (done) return
    done = true
    closed = true
    if (child !== null && child.exitCode === null) child.kill('SIGKILL')
    res.end()
  }
  // `res` closes when the connection goes away; `req` closed already once its
  // body was read, which would kill every run before it started.
  res.on('close', stop)

  let plan = null
  for (const candidate of plans) {
    child = await spawnCandidate(candidate, target)
    if (child !== undefined) {
      plan = candidate
      break
    }
  }
  if (plan === null) {
    emit({ type: 'fail', error: `找不到可用的解释器（试过：${plans.map((item) => item.cmd).join(' / ')}）` })
    finish()
    return
  }

  const command = plan.shell ? plan.cmd : [plan.cmd, ...plan.args].join(' ')
  emit({ type: 'start', command })

  const outDecoder = new StringDecoder('utf8')
  const errDecoder = new StringDecoder('utf8')
  let bytes = 0
  const timer = setTimeout(() => {
    if (child !== null && child.exitCode === null) child.kill('SIGKILL')
  }, RUN_TIMEOUT_MS)

  const push = (type, text) => {
    if (text === '') return
    // The cap is on what reaches the browser, not on what the child prints.
    if (bytes >= MAX_OUTPUT) return
    const room = MAX_OUTPUT - bytes
    const piece = text.length <= room ? text : text.slice(0, room)
    bytes += piece.length
    emit({ type, text: piece })
  }

  child.stdout.on('data', (chunk) => push('out', outDecoder.write(chunk)))
  child.stderr.on('data', (chunk) => push('err', errDecoder.write(chunk)))

  child.on('error', (error) => {
    clearTimeout(timer)
    emit({ type: 'fail', error: String((error && error.message) || error) })
    finish()
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    push('out', outDecoder.end())
    push('err', errDecoder.end())
    emit({ type: 'end', code, ok: code === 0, ms: Date.now() - started, command })
    finish()
  })
}

/**
 * The environment every child runs with.
 *
 * `PYTHONUNBUFFERED` is the load-bearing one: Python block-buffers stdout when
 * it is not a TTY, so without it a script's output arrives in one lump at exit
 * and streaming looks broken even though the pipe is flushed correctly.
 */
function childEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  }
}

/**
 * Spawn one candidate, resolving `undefined` when the executable is absent.
 *
 * Waiting for `spawn` rather than guessing at the PATH is what makes the
 * fallback chain honest: `python` missing on this Host simply moves on to `py`.
 */
function spawnCandidate(plan, target) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(plan.cmd, plan.args, {
        cwd: dirname(target),
        shell: plan.shell,
        windowsHide: true,
        env: childEnv(),
      })
    } catch {
      resolve(undefined)
      return
    }
    const onError = (error) => {
      child.removeListener('spawn', onSpawn)
      resolve(error && error.code === 'ENOENT' ? undefined : child)
    }
    const onSpawn = () => {
      child.removeListener('error', onError)
      resolve(child)
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}

/**
 * Run one file, trying each interpreter candidate until one exists.
 * @param body - `{ root, path, command? }`.
 * @param res - node response.
 */
async function handleRun(body, res) {
  const target = containedPath(body.root, body.path)
  const plans = planRun(target, body.command)
  const started = Date.now()

  for (const plan of plans) {
    const result = await tryPlan(plan, target, started)
    if (result !== undefined) {
      send(res, 200, result)
      return
    }
  }

  send(res, 200, {
    ok: false,
    code: null,
    stdout: '',
    stderr: `找不到可用的解释器（试过：${plans.map((plan) => plan.cmd).join(' / ')}）`,
    ms: Date.now() - started,
  })
}

/**
 * Send one JSON response.
 * @param res - node response.
 * @param status - HTTP status.
 * @param payload - JSON-serialisable body.
 */
function send(res, status, payload) {
  if (res.headersSent) return
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}
