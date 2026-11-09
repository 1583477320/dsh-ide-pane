/**
 * Client half of dsh-ide-pane.
 *
 * Registers a right-sidebar tab type (`ide`) that browses the session
 * workspace and renders files read-only, with a live refresh when the Agent
 * rewrites the open file.
 *
 * Host coupling is deliberately thin: file access goes through the first-party
 * `remote.workspaceFiles` namespace (list / read / stat), so this plugin owns no
 * filesystem permission of its own and inherits the session's workspace scope.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ide-pane',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Tab implementation id (unique across all registered types). */
    const TYPE_ID = 'dsh-ide-pane/code'
    /** Build marker, logged once on mount so a stale bundle is identifiable. */
    const CLIENT_VERSION = '0.15.0'

    /** Route prefix owned by the Host half. */
    const ROUTE_PREFIX = '/dsh-ide-pane'
    /** Page kind: page types open by kind, not by resource pattern. */
    const KIND = 'ide'

    /**
     * Root attribute that hands the shell to the IDE: the left column drops to
     * zero width and the right column takes the larger share of the frame.
     * Set only while this pane is actually visible, so closing or switching
     * away from the tab restores the conversation layout.
     */
    const DOMINANT_ATTR = 'data-ide-dominant'

    /**
     * Class names come from CSS modules and change between builds, so the
     * rules match on the stable suffix (``*_sidebarCol``) instead of the hash.
     */
    const DOMINANT_CSS = `
      @media (min-width: 1024px) {
        html[data-ide-dominant] [class*="_frame"]:has(> [class*="_sidebarCol"]) {
          grid-template-columns: 0px minmax(360px, 1fr) minmax(0, 1.6fr) !important;
        }
        html[data-ide-dominant] [class*="_centerCol"] { min-width: 0 !important; }
      }
    `

    /**
     * Hover feedback for the file tree and the recent-file list.
     *
     * Inline styles cannot express `:hover`, and a flat list with no hover
     * reads as a static picture rather than something you can click.
     */
    const TREE_CSS = `
      [data-ide-row] { transition: background 90ms ease; }
      [data-ide-row]:hover { background: rgba(127,127,127,.14); }
    `

    /**
     * The edit surface paints its glyphs in an overlay, so the textarea itself
     * is transparent. A translucent selection keeps the highlighted text
     * readable underneath instead of hiding it behind an opaque block.
     */
    const EDITOR_CSS = `
      [data-dsh-ide-editor] textarea::selection { background: rgba(91,140,255,.28); }
      [data-dsh-ide-editor] textarea::-moz-selection { background: rgba(91,140,255,.28); }
    `

    /** How many lines one tab renders before offering to open a range. */
    const MAX_LINES = 2000
    /** Files longer than this skip highlight tokens while editing. */
    const MAX_HIGHLIGHT_LINES = 4000
    /** Live-refresh cadence for the open file, in ms. */
    const POLL_MS = 2000
    /** Most per-edit chips shown before older ones fold behind a count. */
    const EDIT_STRIP_LIMIT = 12
    /** How long a terminal create/attach may take before the pane falls back. */
    const TERMINAL_START_MS = 4000

    /**
     * The reference a drag is currently carrying, if it started in this pane.
     *
     * Module scope because the drop lands outside the pane: the handler that
     * receives it is a document listener, not a React prop.
     */
    let draggingReference = null

    // ─────────────────────────────── syntax ───────────────────────────────

    /** Keyword sets per language family. */
    const KEYWORDS = {
      py: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
      js: 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while yield',
      md: '',
    }

    /** One lexical rule: [token kind, sticky-ish regex]. */
    function rulesFor(lang) {
      const words = (KEYWORDS[lang] || '').split(' ').filter(Boolean)
      const wordRule = words.length
        ? new RegExp(`^(?:${words.join('|')})\\b`)
        : null
      const rules = []
      if (lang === 'py') rules.push(['comment', /^#[^\n]*/])
      if (lang === 'js' || lang === 'css') rules.push(['comment', /^\/\/[^\n]*/])
      rules.push(
        ['string', /^(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/],
        ['number', /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/],
      )
      if (wordRule) rules.push(['keyword', wordRule])
      rules.push(
        ['ident', /^[A-Za-z_$][A-Za-z0-9_$]*/],
        ['punct', /^[^\sA-Za-z0-9_$]+/],
        ['space', /^\s+/],
      )
      return rules
    }

    /** Guess a language family from the file extension. */
    function langOf(path) {
      const ext = (path.split('.').pop() || '').toLowerCase()
      if (ext === 'py' || ext === 'pyw') return 'py'
      if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json'].includes(ext)) return 'js'
      if (['css', 'scss', 'less'].includes(ext)) return 'css'
      if (['md', 'markdown', 'txt', 'log', 'yml', 'yaml'].includes(ext)) return 'md'
      return 'txt'
    }

    /**
     * Split one source line into coloured tokens.
     * @param line - the raw line text.
     * @param lang - language family from `langOf`.
     * @returns [{ kind, text }] covering the whole line.
     */
    function tokenize(line, lang) {
      if (lang === 'md') return [{ kind: 'plain', text: line }]
      const rules = rulesFor(lang)
      const out = []
      let rest = line
      let guard = 0
      while (rest.length > 0 && guard < 4000) {
        guard += 1
        let matched = false
        for (const [kind, re] of rules) {
          const m = re.exec(rest)
          if (m === null) continue
          out.push({ kind, text: m[0] })
          rest = rest.slice(m[0].length)
          matched = true
          break
        }
        if (!matched) {
          out.push({ kind: 'plain', text: rest[0] })
          rest = rest.slice(1)
        }
      }
      return out
    }

    /** Token colours, taken from the DSH theme with static fallbacks. */
    const TOKEN_COLOR = {
      keyword: 'var(--dsw-static-deepseek-400, #7aa2ff)',
      string: 'var(--dsw-alias-state-success-primary, #5fd3a0)',
      number: 'var(--dsw-static-amber-400, #c4a0ff)',
      comment: 'var(--dsw-alias-label-tertiary, #6b7684)',
      ident: 'inherit',
      punct: 'var(--dsw-alias-label-secondary, #98a3b3)',
      space: 'inherit',
      plain: 'inherit',
    }

    // ─────────────────────────────── helpers ──────────────────────────────

    /**
     * Drop escape sequences a plain text view cannot honour.
     *
     * SGR (`…m`) is kept, because the renderer turns it into styles. Cursor
     * moves, erases and OSC titles are removed, since the pane shows a growing
     * text buffer rather than a terminal screen.
     */
    function sanitizeTerminal(text) {
      return String(text)
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, (match) => (match.endsWith('m') ? match : ''))
        .replace(/\u001b[@-Z\\-_]/g, '')
    }

    /**
     * Fold `\r` the way a terminal does: the line is rewritten from the start.
     *
     * This is what makes a progress bar render as one changing line instead of
     * a column of snapshots — the common case that a `<pre>` gets wrong.
     */
    function applyCarriageReturns(text) {
      return String(text)
        // CRLF is a line break, not a cursor return: folding it away first keeps
        // `\r` meaning only what it means mid-line.
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
        .join('\n')
    }

    /** Quote one path segment for a shell command line. */
    function quoteArgument(value) {
      return `"${String(value).replaceAll('"', '\\"')}"`
    }

    /** The command a terminal should run for a file, by its extension. */
    function planRunCommand(path) {
      const target = quoteArgument(path)
      const lower = String(path).toLowerCase()
      if (lower.endsWith('.py')) return `python ${target}`
      if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return `node ${target}`
      if (lower.endsWith('.ps1')) return `pwsh -NoLogo -File ${target}`
      if (lower.endsWith('.sh') || lower.endsWith('.bash')) return `bash ${target}`
      return target
    }

    // ─────────────────────────────── markdown ─────────────────────────────

    /**
     * TeX symbol table for the math subset below.
     *
     * Scientific prose is mostly symbols and scripts, so this covers the
     * Greek letters, relations, operators and punctuation that actually appear
     * inline; anything unknown is shown verbatim rather than dropped.
     */
    const MATH_SYMBOLS = {
      alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
      zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
      lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
      tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
      Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
      Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
      times: '×', cdot: '·', pm: '±', mp: '∓', div: '÷', ast: '∗', star: '⋆',
      le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
      sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', equiv: '≡',
      infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', oint: '∮',
      to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
      leftrightarrow: '↔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
      in: '∈', notin: '∉', subset: '⊂', supset: '⊃', cup: '∪', cap: '∩',
      emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
      therefore: '∴', because: '∵', degree: '°', prime: '′', ell: 'ℓ',
      ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
      gtrsim: '≳', lesssim: '≲', gtrdot: '⋗', lessdot: '⋖',
      gapprox: '⪆', lapprox: '⪅', lsim: '≲', gsim: '≳',
      nleq: '≰', ngeq: '≱', nless: '≮', ngtr: '≯', nsim: '≁', napprox: '≉',
      prec: '≺', succ: '≻', preceq: '≼', succeq: '≽',
      sqsubseteq: '⊑', sqsupseteq: '⊒', models: '⊨', vdash: '⊢', dashv: '⊣',
      top: '⊤', bot: '⊥', angle: '∠', triangle: '△', square: '□',
      oplus: '⊕', otimes: '⊗', odot: '⊙', bigoplus: '⨁', bigotimes: '⨂',
      setminus: '∖', complement: '∁', implies: '⟹', iff: '⟺', impliedby: '⟸',
      coloneqq: '≔', eqqcolon: '≕', checkmark: '✓',

      langle: '⟨', rangle: '⟩', lbrace: '{', rbrace: '}', lceil: '⌈', rceil: '⌉',
      lfloor: '⌊', rfloor: '⌋', vert: '|', Vert: '‖', mid: '|',
      quad: '\u2003', qquad: '\u2003\u2003',
      '%': '%', '&': '&', '#': '#', _: '_', '{': '{', '}': '}', $: '$',
      log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
      max: 'max', min: 'min', arg: 'arg', sup: 'sup', inf: 'inf', lim: 'lim',
    }

    /** Text-style commands render upright; the rest stays as-is. */
    const MATH_UPRIGHT = new Set(['mathrm', 'text', 'textrm', 'operatorname', 'mathbf', 'mathsf', 'mathtt'])

    /**
     * Accent commands and the combining mark they put on their argument.
     *
     * Combining marks keep the accented glyph in the text baseline, which is
     * what makes `\hat{y}_i` line up with its subscript instead of floating.
     */
    const MATH_ACCENT = {
      hat: '\u0302',
      widehat: '\u0302',
      tilde: '\u0303',
      widetilde: '\u0303',
      vec: '\u20d7',
      dot: '\u0307',
      ddot: '\u0308',
      acute: '\u0301',
      grave: '\u0300',
      check: '\u030c',
      breve: '\u0306',
      mathring: '\u030a',
    }

    /** Commands that only size or fence a group; the group speaks for itself. */
    const MATH_SILENT = new Set([
      'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
      'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr',
      'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits',
    ])

    /** Punctuation after a backslash: spacing and escaped literals. */
    const MATH_ESCAPED = {
      ',': '\u2009',
      ':': '\u2005',
      ';': '\u2005',
      '!': '',
      ' ': ' ',
      '\\': ' ',
    }

    const MATH_SUP = { fontSize: '0.72em', verticalAlign: 'super', lineHeight: 0 }
    const MATH_SUB = { fontSize: '0.72em', verticalAlign: 'sub', lineHeight: 0 }

    /**
     * Render a TeX fragment to React nodes.
     *
     * A reader for math that appears in Markdown, not a TeX engine: scripts,
     * fractions, roots, upright text and the symbol table above. Unknown
     * commands are echoed so a typo is visible instead of silent.
     */
    function mathNodes(h, tex, keyBase) {
      const source = String(tex)
      let at = 0

      /** Read one argument: `{...}` group, `\command`, or a single character. */
      const readGroup = () => {
        while (source[at] === ' ') at += 1
        if (source[at] === '{') {
          let depth = 0
          const start = at + 1
          for (; at < source.length; at += 1) {
            if (source[at] === '\\') {
              at += 1
              continue
            }
            if (source[at] === '{') depth += 1
            else if (source[at] === '}') {
              depth -= 1
              if (depth === 0) {
                const inner = source.slice(start, at)
                at += 1
                return inner
              }
            }
          }
          return source.slice(start)
        }
        if (source[at] === '\\') {
          const start = at
          at += 1
          while (at < source.length && /[A-Za-z]/.test(source[at])) at += 1
          return source.slice(start, at)
        }
        const single = source[at] ?? ''
        at += 1
        return single
      }

      const out = []
      let buffer = ''
      const flush = () => {
        if (buffer !== '') {
          out.push(buffer)
          buffer = ''
        }
      }

      while (at < source.length) {
        const char = source[at]

        if (char === '\\') {
          const start = at
          at += 1
          if (at >= source.length) {
            buffer += '\\'
            break
          }
          // A backslash before punctuation is spacing or an escaped literal,
          // never the punctuation itself: `\,` is a thin space, not a comma.
          if (!/[A-Za-z]/.test(source[at])) {
            const escaped = source[at]
            buffer += Object.prototype.hasOwnProperty.call(MATH_ESCAPED, escaped) ? MATH_ESCAPED[escaped] : escaped
            at += 1
            continue
          }
          while (at < source.length && /[A-Za-z]/.test(source[at])) at += 1
          const name = source.slice(start + 1, at)

          // Fence and size commands contribute nothing of their own.
          if (MATH_SILENT.has(name)) continue

          if (Object.prototype.hasOwnProperty.call(MATH_ACCENT, name)) {
            flush()
            const body = readGroup()
            const mark = MATH_ACCENT[name]
            // A plain argument takes the combining mark on its last character,
            // which keeps the accent inside the text line box.
            if (!/[\\^_{}]/.test(body) && body !== '') {
              out.push(body.slice(0, -1) + body.slice(-1) + mark)
            } else {
              out.push(
                h(
                  'span',
                  { key: `${keyBase}-a${out.length}`, style: { textDecoration: 'overline', textDecorationThickness: '1px' } },
                  mathNodes(h, body, `${keyBase}a${out.length}`),
                ),
              )
            }
            continue
          }

          if (name === 'bar' || name === 'overline') {
            flush()
            const body = readGroup()
            out.push(
              h(
                'span',
                { key: `${keyBase}-o${out.length}`, style: { textDecoration: 'overline', textDecorationThickness: '1px' } },
                mathNodes(h, body, `${keyBase}o${out.length}`),
              ),
            )
            continue
          }

          if (name === 'underline') {
            flush()
            const body = readGroup()
            out.push(
              h(
                'span',
                { key: `${keyBase}-n${out.length}`, style: { textDecoration: 'underline' } },
                mathNodes(h, body, `${keyBase}n${out.length}`),
              ),
            )
            continue
          }

          if (name === 'mathbf' || name === 'boldsymbol' || name === 'pmb') {
            flush()
            const body = readGroup()
            out.push(
              h(
                'span',
                { key: `${keyBase}-b${out.length}`, style: { fontWeight: 600 } },
                mathNodes(h, body, `${keyBase}b${out.length}`),
              ),
            )
            continue
          }

          if (name === 'mathcal' || name === 'mathscr' || name === 'mathit') {
            flush()
            const body = readGroup()
            out.push(
              h(
                'span',
                { key: `${keyBase}-c${out.length}`, style: { fontStyle: 'italic' } },
                mathNodes(h, body, `${keyBase}c${out.length}`),
              ),
            )
            continue
          }

          if (name === 'mathbb') {
            flush()
            const body = readGroup()
            out.push(
              h(
                'span',
                { key: `${keyBase}-d${out.length}`, style: { fontWeight: 600, letterSpacing: '0.02em' } },
                mathNodes(h, body, `${keyBase}d${out.length}`),
              ),
            )
            continue
          }

          if (MATH_UPRIGHT.has(name)) {
            flush()
            const body = readGroup()
            out.push(h('span', { key: `${keyBase}-u${out.length}`, style: { fontStyle: 'normal' } }, body))
            continue
          }
          if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
            flush()
            const top = readGroup()
            const bottom = readGroup()
            out.push(
              h(
                'span',
                { key: `${keyBase}-f${out.length}`, style: { whiteSpace: 'nowrap' } },
                h('span', { style: { verticalAlign: 'baseline' } }, mathNodes(h, top, `${keyBase}f${out.length}a`)),
                h('span', { style: { padding: '0 2px' } }, '/'),
                h('span', null, mathNodes(h, bottom, `${keyBase}f${out.length}b`)),
              ),
            )
            continue
          }
          if (name === 'sqrt') {
            flush()
            const body = readGroup()
            out.push(
              h('span', { key: `${keyBase}-r${out.length}`, style: { whiteSpace: 'nowrap' } }, '√', mathNodes(h, body, `${keyBase}r${out.length}`)),
            )
            continue
          }
          if (Object.prototype.hasOwnProperty.call(MATH_SYMBOLS, name)) {
            buffer += MATH_SYMBOLS[name]
            continue
          }
          // Unknown command: keep it visible, in a muted tone.
          flush()
          out.push(h('span', { key: `${keyBase}-x${out.length}`, style: { opacity: 0.7 } }, `\\${name}`))
          continue
        }

        if (char === '^' || char === '_') {
          at += 1
          const body = readGroup()
          flush()
          out.push(
            h(
              char === '^' ? 'sup' : 'sub',
              { key: `${keyBase}-${char}${out.length}`, style: char === '^' ? MATH_SUP : MATH_SUB },
              mathNodes(h, body, `${keyBase}${char}${out.length}`),
            ),
          )
          continue
        }

        if (char === '{' || char === '}') {
          at += 1
          continue
        }

        buffer += char
        at += 1
      }

      flush()
      return out
    }

    /**
     * Inline markdown to React nodes.
     *
     * One left-to-right scan rather than per-construct regexes: a bold run may
     * contain a formula, and a formula may sit next to a link, so the constructs
     * cannot be peeled off one layer at a time. Elements only — the pane renders
     * whatever a file contains, so no markup reaches the DOM as a string.
     */
    function inlineNodes(h, text, keyBase) {
      const source = String(text)
      const nodes = []
      let plain = ''
      let at = 0
      let key = 0

      const flush = () => {
        if (plain !== '') {
          nodes.push(plain)
          plain = ''
        }
      }
      const next = () => {
        flush()
        key += 1
        return `${keyBase}-${key}`
      }

      while (at < source.length) {
        const char = source[at]

        // A backslash escapes the markdown character that follows, so `\#2`
        // reads as `#2` instead of starting a heading.
        if (char === '\\' && /[\\`*_{}[\]()#+\-.!$>|~]/.test(source[at + 1] ?? '')) {
          plain += source[at + 1]
          at += 2
          continue
        }

        if (char === '`') {
          const end = source.indexOf('`', at + 1)
          if (end > at + 1) {
            nodes.push(h('code', { key: next(), style: MD.codeInline }, source.slice(at + 1, end)))
            at = end + 1
            continue
          }
        }

        if (char === '*' && source[at + 1] === '*') {
          const end = source.indexOf('**', at + 2)
          if (end > at + 2) {
            nodes.push(h('strong', { key: next() }, inlineNodes(h, source.slice(at + 2, end), `${keyBase}b${at}`)))
            at = end + 2
            continue
          }
        }

        if (char === '*') {
          const end = source.indexOf('*', at + 1)
          if (end > at + 1) {
            nodes.push(h('em', { key: next() }, inlineNodes(h, source.slice(at + 1, end), `${keyBase}i${at}`)))
            at = end + 1
            continue
          }
        }

        if (char === '[') {
          const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(source.slice(at))
          if (link !== null) {
            nodes.push(
              h(
                'a',
                {
                  key: next(),
                  href: link[2],
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  style: MD.link,
                  // A file may point anywhere; opening it must never navigate the app away.
                  onClick: (event) => event.stopPropagation(),
                },
                link[1],
              ),
            )
            at += link[0].length
            continue
          }
        }

        if (char === '$' && source[at - 1] !== '\\') {
          let close = -1
          for (let scan = at + 1; scan < source.length && source[scan] !== '\n'; scan += 1) {
            if (source[scan] === '$' && source[scan - 1] !== '\\') {
              close = scan
              break
            }
          }
          const body = close === -1 ? '' : source.slice(at + 1, close)
          // Whitespace at either edge marks currency, not a formula; a failing
          // pair is left as text and the scan simply moves on.
          const opens = body !== '' && !/^\s/.test(body)
          const closes = body !== '' && !/\s$/.test(body) && !/^\d/.test(source[close + 1] ?? '')
          if (close !== -1 && opens && closes) {
            nodes.push(h('span', { key: next(), style: MD.math }, mathNodes(h, body, `${keyBase}m${at}`)))
            at = close + 1
            continue
          }
        }

        plain += char
        at += 1
      }

      flush()
      return nodes
    }

    /** Split a table row into cells. */
    function tableCells(line) {
      return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
    }

    /**
     * Markdown to React nodes.
     *
     * A deliberately small subset — headings, fences, lists, quotes, tables,
     * rules and the inline forms above. It is a reader for source files in a
     * 480px pane, not a replacement for the shipped document preview.
     */
    function renderMarkdown(h, text) {
      const lines = String(text).replace(/\r\n/g, '\n').split('\n')
      const out = []
      let i = 0
      let block = 0
      const push = (node) => {
        out.push(node)
        block += 1
      }

      while (i < lines.length) {
        const line = lines[i]

        if (line.trim() === '') {
          i += 1
          continue
        }

        // A fence runs until its closing marker or the end of the file.
        const fence = /^\s*```(\S*)\s*$/.exec(line)
        if (fence !== null) {
          const body = []
          i += 1
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
            body.push(lines[i])
            i += 1
          }
          i += 1
          push(
            h(
              'pre',
              { key: `b${block}`, style: MD.fence },
              h('code', null, body.join('\n')),
            ),
          )
          continue
        }

        // Display math: `$$…$$` or `\[…\]`, possibly spanning lines.
        const displayOpen = /^\s*(\$\$|\\\[)\s*(.*)$/.exec(line)
        if (displayOpen !== null) {
          const closer = displayOpen[1] === '$$' ? '$$' : '\\]'
          let body = displayOpen[2]
          let closedOnFirstLine = false
          if (body.includes(closer)) {
            body = body.slice(0, body.indexOf(closer))
            closedOnFirstLine = true
            i += 1
          }
          if (!closedOnFirstLine) {
            i += 1
            const rest = []
            while (i < lines.length && !lines[i].includes(closer)) {
              rest.push(lines[i])
              i += 1
            }
            if (i < lines.length) {
              rest.push(lines[i].slice(0, lines[i].indexOf(closer)))
              i += 1
            }
            body = [body, ...rest].join(' ').trim()
          }
          push(h('div', { key: `b${block}`, style: MD.mathBlock }, mathNodes(h, body, `mm${block}`)))
          continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = heading[1].length
          push(h(`h${level}`, { key: `b${block}`, style: MD[`h${level}`] }, inlineNodes(h, heading[2], `h${block}`)))
          i += 1
          continue
        }

        if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
          push(h('div', { key: `b${block}`, style: MD.hr }))
          i += 1
          continue
        }

        // Table: a header row followed by a separator row.
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
          const header = tableCells(line)
          i += 2
          const rows = []
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
            rows.push(tableCells(lines[i]))
            i += 1
          }
          push(
            h(
              'table',
              { key: `b${block}`, style: MD.table },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  header.map((cell, c) => h('th', { key: c, style: MD.th }, inlineNodes(h, cell, `th${block}-${c}`))),
                ),
              ),
              h(
                'tbody',
                null,
                rows.map((row, r) =>
                  h(
                    'tr',
                    { key: r },
                    row.map((cell, c) => h('td', { key: c, style: MD.td }, inlineNodes(h, cell, `td${block}-${r}-${c}`))),
                  ),
                ),
              ),
            ),
          )
          continue
        }

        if (/^\s*>/.test(line)) {
          const body = []
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          push(
            h(
              'blockquote',
              { key: `b${block}`, style: MD.quote },
              inlineNodes(h, body.join(' '), `q${block}`),
            ),
          )
          continue
        }

        const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
        if (bullet !== null) {
          const ordered = /\d/.test(bullet[2])
          const items = []
          while (i < lines.length) {
            const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
            if (item === null) break
            const depth = Math.floor(item[1].length / 2)
            const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3])
            const label = task === null
              ? inlineNodes(h, item[3], `li${block}-${items.length}`)
              : [
                  h('span', { key: 'box', style: MD.check }, task[1].trim() === '' ? '☐' : '☑'),
                  ...inlineNodes(h, task[2], `li${block}-${items.length}`),
                ]
            items.push(h('li', { key: items.length, style: { ...MD.li, marginLeft: `${depth * 14}px` } }, label))
            i += 1
          }
          push(h(ordered ? 'ol' : 'ul', { key: `b${block}`, style: MD.list }, items))
          continue
        }

        const paragraph = []
        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          !/^\s*(#{1,6}\s|```|\||>|[-*+]\s|\d+[.)]\s|\$\$|\\\[)/.test(lines[i])
        ) {
          paragraph.push(lines[i])
          i += 1
        }
        if (paragraph.length === 0) {
          // Unknown construct: show the line rather than silently dropping it.
          paragraph.push(lines[i])
          i += 1
        }
        push(h('p', { key: `b${block}`, style: MD.p }, inlineNodes(h, paragraph.join(' '), `p${block}`)))
      }

      return out
    }

    /** True when a path should default to the rendered view. */
    function isMarkdown(path) {
      return typeof path === 'string' && /\.(md|markdown)$/i.test(path)
    }

    /** Palette for the sixteen SGR colours, chosen to read on both themes. */
    const ANSI_COLOR = {
      30: '#5d6775',
      31: '#ff6b6b',
      32: '#3ddc97',
      33: '#e8b339',
      34: '#5b8cff',
      35: '#b48cff',
      36: '#38bdf8',
      37: '#e7ecf3',
      90: '#8a94a6',
      91: '#ff9292',
      92: '#6ee7b7',
      93: '#f2cd6b',
      94: '#85a8ff',
      95: '#cba6ff',
      96: '#67d4ff',
      97: '#ffffff',
    }

    /**
     * Split text carrying SGR escapes into styled runs.
     *
     * Program output is often plain; returning `null` for that case keeps the
     * common path allocation-free. Extended colours (`38;5;n`, `38;2;r;g;b`)
     * are skipped as a unit, because their numeric arguments would otherwise be
     * misread as colour codes of their own.
     * @returns run list, or `null` when the text carries no escapes.
     */
    function ansiSegments(text) {
      if (typeof text !== 'string' || text.indexOf('\u001b[') === -1) return null
      const pattern = /\u001b\[([0-9;]*)m/g
      const runs = []
      let style = {}
      let index = 0
      let match = pattern.exec(text)
      while (match !== null) {
        if (match.index > index) runs.push({ text: text.slice(index, match.index), ...style })
        index = pattern.lastIndex
        const params = match[1] === '' ? [0] : match[1].split(';').map(Number)
        for (let i = 0; i < params.length; i += 1) {
          const code = params[i]
          if (code === 38 || code === 48) {
            const mode = params[i + 1]
            i += mode === 5 ? 2 : mode === 2 ? 4 : 1
            continue
          }
          if (code === 0) style = {}
          else if (code === 1) style = { ...style, bold: true }
          else if (code === 2) style = { ...style, dim: true }
          else if (code === 3) style = { ...style, italic: true }
          else if (code === 4) style = { ...style, underline: true }
          else if (code === 22) style = { ...style, bold: false, dim: false }
          else if (code === 23) style = { ...style, italic: false }
          else if (code === 24) style = { ...style, underline: false }
          else if (code === 39) style = { ...style, color: undefined }
          else if (ANSI_COLOR[code] !== undefined) style = { ...style, color: ANSI_COLOR[code] }
        }
        match = pattern.exec(text)
      }
      if (index < text.length) runs.push({ text: text.slice(index), ...style })
      return runs
    }

    /** Join a workspace-relative directory with one child name. */
    function childPath(parent, name) {
      return parent === '' ? name : `${parent.replace(/[/\\]+$/, '')}/${name}`
    }

    /** True when the entry is a directory. */
    function isDir(entry) {
      return entry && (entry.type === 'directory' || entry.kind === 'directory')
    }

    /**
     * Best-effort session id when the slot did not hand one over.
     * Keeps the pane useful instead of showing an empty tree forever.
     * @param sessions - the sessions list store, or a plain snapshot.
     * @returns the id, or `''` when the store has no row yet.
     */
    function currentSessionId(sessions) {
      try {
        const list = sessions && typeof sessions.getSnapshot === 'function' ? sessions.getSnapshot() : sessions
        if (!list) return ''
        if (typeof list.current === 'string' && list.current) return list.current
        const byId = list.byId || {}
        for (const id of Object.keys(byId)) {
          const entry = byId[id]
          if (entry && entry.retainedBy && entry.retainedBy.mainView) return id
        }
        return Object.keys(byId)[0] || ''
      } catch {
        return ''
      }
    }

    /** Human label for a failed Remote call. */
    function failureText(result) {
      const error = result && result.error
      if (!error) return '读取失败'
      return String(error.code || error.message || error)
    }

    /**
     * Reject instead of hanging when a Remote call never settles.
     * A stuck call must surface as a visible failure, not an endless spinner.
     * @param promise - the in-flight Remote call.
     * @param ms - budget in milliseconds.
     * @param label - what was being called, for the message.
     */
    function withTimeout(promise, ms, label) {
      let timer
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时 ${ms}ms`)), ms)
      })
      return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
    }

    /** An `@path` mention, quoted when the path contains whitespace. */
    function fileReference(path) {
      const raw = String(path || '')
      const escaped = raw.replaceAll('"', '\\"')
      return /\s/.test(raw) ? `@"${escaped}"` : `@${raw}`
    }

    /** Turn a path and one-based line interval into a composer reference. */
    function lineReference(path, start, end) {
      const base = fileReference(path)
      return `${base}:${start}${end > start ? `-${end}` : ''}`
    }

    /** One-based line interval covered by a textarea selection. */
    function selectedLines(text, start, end) {
      if (typeof text !== 'string' || start === end) return null
      const first = text.slice(0, start).split('\n').length
      let last = text.slice(0, end).split('\n').length
      // A selection ending exactly at a line boundary belongs to the prior line.
      if (end > start && text[end - 1] === '\n') last = Math.max(first, last - 1)
      return { start: first, end: last }
    }

    // ──────────────────────────── file versions ───────────────────────────

    /**
     * Prefix for the per-file version records.
     *
     * A record holds the text this pane last observed and the text it held
     * before that, which is what makes "compare with the previous version"
     * survive closing the diff, switching tabs, and reloading the page.
     */
    const BASELINE_PREFIX = 'dsh-ide-pane/base/v1'
    /** Files larger than this keep no record; diffing them is not useful. */
    const BASELINE_MAX_TEXT = 200000
    /** How many files keep a record before the oldest are dropped. */
    const BASELINE_MAX_ENTRIES = 40
    /** Fallback for environments without `localStorage` (tests, private mode). */
    const baselineMemory = new Map()

    /** Storage handle, or `null` when the browser refuses it. */
    function baselineStore() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return null
        return localStorage
      } catch {
        return null
      }
    }

    /**
     * One storage key per file.
     *
     * The path is normalized so the same file reached through the tree
     * (`D:\a\b.py`) and through a chat reference (`D:/a/b.py`) shares a record.
     */
    function baselineKey(sessionId, path) {
      return `${BASELINE_PREFIX}/${sessionId}/${normPath(path)}`
    }

    /** Drop the oldest records once the store is over its entry budget. */
    function pruneBaselines(store) {
      const keys = []
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i)
        if (typeof key === 'string' && key.startsWith(BASELINE_PREFIX)) keys.push(key)
      }
      if (keys.length <= BASELINE_MAX_ENTRIES) return
      const dated = keys.map((key) => {
        let at = 0
        try {
          const parsed = JSON.parse(store.getItem(key))
          if (parsed && typeof parsed.at === 'number') at = parsed.at
        } catch {
          at = 0
        }
        return { key, at }
      })
      dated.sort((a, b) => a.at - b.at)
      for (const entry of dated.slice(0, dated.length - BASELINE_MAX_ENTRIES)) store.removeItem(entry.key)
    }

    /** Read one file's record, or `null` when there is none. */
    function readVersion(sessionId, path) {
      const key = baselineKey(sessionId, path)
      const store = baselineStore()
      const raw = store ? store.getItem(key) : baselineMemory.get(key)
      if (typeof raw !== 'string') return null
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.text !== 'string') return null
        return { text: parsed.text, prev: typeof parsed.prev === 'string' ? parsed.prev : null }
      } catch {
        return null
      }
    }

    /** Persist one file's record. */
    function writeVersion(sessionId, path, record) {
      if (typeof record.text !== 'string' || record.text.length > BASELINE_MAX_TEXT) return
      if (typeof record.prev === 'string' && record.prev.length > BASELINE_MAX_TEXT) {
        record = { text: record.text, prev: null }
      }
      const key = baselineKey(sessionId, path)
      const raw = JSON.stringify({ text: record.text, prev: record.prev, at: Date.now() })
      const store = baselineStore()
      if (store) {
        try {
          pruneBaselines(store)
          store.setItem(key, raw)
          return
        } catch {
          /* quota or a disabled store: keep the in-memory copy instead */
        }
      }
      baselineMemory.set(key, raw)
    }

    /**
     * Record what a file contains now and report what to compare it against.
     *
     * The comparison point is always the text observed immediately before the
     * current one. Re-reading unchanged content leaves the record alone, so the
     * last real change stays visible however many times the pane reloads.
     * @returns `{ prev, text }`; `prev` is `null` for a file seen for the first time.
     */
    function observeVersion(sessionId, path, text) {
      const record = readVersion(sessionId, path)
      if (record === null) {
        writeVersion(sessionId, path, { text, prev: null })
        return { prev: null, text }
      }
      if (record.text === text) return { prev: record.prev, text }
      writeVersion(sessionId, path, { text, prev: record.text })
      return { prev: record.text, text }
    }

    /** Forget one file's comparison, keeping the text it currently holds. */
    function clearVersion(sessionId, path) {
      const record = readVersion(sessionId, path)
      if (record === null) return
      writeVersion(sessionId, path, { text: record.text, prev: null })
    }

    /**
     * Files this pane has shown before, newest first.
     *
     * The baseline keys already encode "a file you actually looked at", which is
     * a better recency signal than the directory listing: it is what the empty
     * state can offer without scanning the workspace.
     * @returns `{ path, at }` rows, at most `limit`.
     */
    function recentBaselines(sessionId, limit) {
      const prefix = `${BASELINE_PREFIX}/${sessionId}/`
      const rows = []
      const store = baselineStore()
      const read = (raw) => {
        try {
          const parsed = JSON.parse(raw)
          return parsed && typeof parsed.at === 'number' ? parsed.at : 0
        } catch {
          return 0
        }
      }
      if (store) {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i)
          if (typeof key !== 'string' || !key.startsWith(prefix)) continue
          rows.push({ path: key.slice(prefix.length), at: read(store.getItem(key)) })
        }
      } else {
        for (const [key, raw] of baselineMemory) {
          if (!key.startsWith(prefix)) continue
          rows.push({ path: key.slice(prefix.length), at: read(raw) })
        }
      }
      rows.sort((a, b) => b.at - a.at)
      return rows.slice(0, limit)
    }

    /** Accent per language family, used for the stripe beside a file name. */
    const LANG_ACCENT = {
      py: '#3572a5',
      js: '#c9a227',
      mjs: '#c9a227',
      cjs: '#c9a227',
      ts: '#3178c6',
      jsx: '#61dafb',
      tsx: '#3178c6',
      css: '#7e57c2',
      scss: '#c6538c',
      html: '#e05e2b',
      json: '#8a8f98',
      md: '#4a7fd4',
      yml: '#8a8f98',
      yaml: '#8a8f98',
      sh: '#4eaa25',
      ps1: '#4a7fd4',
    }

    /** Split a name into the part shown plainly and the dimmed extension. */
    function splitName(name) {
      const value = String(name)
      const dot = value.lastIndexOf('.')
      if (dot <= 0 || dot === value.length - 1) return { base: value, ext: '' }
      return { base: value.slice(0, dot), ext: value.slice(dot) }
    }

    /** Accent colour for a file name, or `null` when the type is unknown. */
    function accentOf(name) {
      const value = String(name).toLowerCase()
      const dot = value.lastIndexOf('.')
      if (dot <= 0) return null
      return LANG_ACCENT[value.slice(dot + 1)] || null
    }

    /** Last path segment, tolerating both separators. */
    function baseNameOf(value) {
      const raw = String(value)
      const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
      return cut === -1 ? raw : raw.slice(cut + 1)
    }

    /** Parent path, tolerating both separators. */
    function dirNameOf(value) {
      const raw = String(value)
      const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
      return cut <= 0 ? '' : raw.slice(0, cut)
    }

    /**
     * Whether a file reference in the chat opens this pane.
     *
     * The tab registry ranks candidate types across kinds by priority band
     * first, so an `extension` band type outranks the shipped text preview,
     * which registers as `fallback`. Set this to `false` to give files back to
     * that preview.
     */
    const CLAIM_FILE_TABS = true

    /** Matches every file address; longer matches win ties within a band. */
    const FILE_ADDRESS_GLOB = 'dsh-resource://file/[\\s\\S]+'

    /** Scheme of the addresses the chat's file references carry. */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

    /** Suffixes this pane is willing to render as text. */
    const TEXT_EXTENSIONS = new Set([
      'txt', 'md', 'markdown', 'rst', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini',
      'cfg', 'conf', 'env', 'log', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss',
      'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
      'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
      'ps1', 'bat', 'cmd', 'sql', 'vue', 'svelte', 'gradle', 'lock', 'properties',
      'gitignore', 'gitattributes', 'editorconfig', 'dockerignore', 'mk',
    ])

    /**
     * Split a `dsh-resource://file/…` address into its parts.
     *
     * Mirrors the grammar the shipped preview uses: the first segment is the
     * scope, `session` carries a session id, and every following segment is
     * percent-decoded on its own so a `/` inside a name survives.
     * @returns `{ scope, sessionId, path }`, or `null` for anything else.
     */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return null
      try {
        const cut = address.search(/[?#]/)
        const body = address.slice(FILE_ADDRESS_PREFIX.length, cut === -1 ? undefined : cut)
        const [scope, ...rest] = body.split('/')
        if (scope === 'session') {
          const [id, ...segments] = rest
          if (id === undefined || id === '' || segments.length === 0) return null
          return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
        }
        if (scope === 'absolute') {
          const unc = rest[0] === '' && rest.length > 1
          const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
          if (segments.length === 0 || segments[0] === '') return null
          if (unc) return { scope, sessionId: null, path: `//${segments.join('/')}` }
          const rooted = /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : `/${segments.join('/')}`
          return { scope, sessionId: null, path: rooted }
        }
        return null
      } catch {
        return null
      }
    }

    /** Whether a path is the kind of file this pane can show as text. */
    function looksLikeText(path) {
      const name = baseNameOf(path).toLowerCase()
      if (name === '') return false
      const dot = name.lastIndexOf('.')
      // No suffix, or a dotfile such as `.env`: treat it as text.
      if (dot <= 0) return true
      return TEXT_EXTENSIONS.has(name.slice(dot + 1))
    }

    /**
     * Veto addresses this pane cannot show.
     *
     * Images, PDFs, archives and office documents keep the shipped preview:
     * claiming them would render bytes as if they were source code.
     */
    function openableFileAddress(address) {
      const parsed = parseFileAddress(address)
      return parsed !== null && looksLikeText(parsed.path)
    }

    /** Tab chip label: the file name for a file address, else the pane name. */
    function titleForAddress(address) {
      const parsed = parseFileAddress(address)
      return parsed === null ? '代码' : baseNameOf(parsed.path)
    }

    /** One spelling for comparisons: forward slashes, no trailing slash. */    function normPath(value) {
      return String(value).replace(/\\/g, '/').replace(/\/+$/, '')
    }

    /**
     * Put a log path on the same footing as a tree path.
     *
     * Tool calls may name a file relative to the session directory while the
     * tree holds absolute paths, so relatives are anchored on the root before
     * the two are compared.
     */
    function resolveForCompare(value, base) {
      const raw = normPath(value)
      if (/^[A-Za-z]:\//.test(raw) || raw.startsWith('/')) return raw
      return `${normPath(base)}/${raw.replace(/^\.\//, '')}`
    }

    /**
     * Line diff between two texts.
     *
     * Common prefix and suffix are trimmed first, which is what makes the
     * typical "the Agent changed three lines" case cheap. The remaining middle
     * goes through an LCS table, except past a fixed budget where one replaced
     * block is reported instead — a whole-file rewrite is not worth a quadratic
     * table, and saying "this region was replaced" is still true.
     * @param before - the older text.
     * @param after - the newer text.
     * @returns rows of `{ type, text, aLine, bLine }`.
     */
    function diffLines(before, after) {
      const a = String(before === undefined || before === null ? '' : before).split('\n')
      const b = String(after === undefined || after === null ? '' : after).split('\n')
      const rows = []

      let head = 0
      while (head < a.length && head < b.length && a[head] === b[head]) head += 1
      let endA = a.length
      let endB = b.length
      while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
        endA -= 1
        endB -= 1
      }

      for (let i = 0; i < head; i += 1) rows.push({ type: 'same', text: a[i], aLine: i + 1, bLine: i + 1 })

      const midA = a.slice(head, endA)
      const midB = b.slice(head, endB)
      if (midA.length * midB.length > 250000) {
        for (let i = 0; i < midA.length; i += 1) rows.push({ type: 'del', text: midA[i], aLine: head + i + 1, bLine: null })
        for (let j = 0; j < midB.length; j += 1) rows.push({ type: 'add', text: midB[j], aLine: null, bLine: head + j + 1 })
      } else {
        const n = midA.length
        const m = midB.length
        const table = new Array(n + 1)
        for (let i = 0; i <= n; i += 1) table[i] = new Uint32Array(m + 1)
        for (let i = n - 1; i >= 0; i -= 1) {
          for (let j = m - 1; j >= 0; j -= 1) {
            table[i][j] = midA[i] === midB[j]
              ? table[i + 1][j + 1] + 1
              : Math.max(table[i + 1][j], table[i][j + 1])
          }
        }
        let i = 0
        let j = 0
        while (i < n && j < m) {
          if (midA[i] === midB[j]) {
            rows.push({ type: 'same', text: midA[i], aLine: head + i + 1, bLine: head + j + 1 })
            i += 1
            j += 1
          } else if (table[i + 1][j] >= table[i][j + 1]) {
            rows.push({ type: 'del', text: midA[i], aLine: head + i + 1, bLine: null })
            i += 1
          } else {
            rows.push({ type: 'add', text: midB[j], aLine: null, bLine: head + j + 1 })
            j += 1
          }
        }
        while (i < n) {
          rows.push({ type: 'del', text: midA[i], aLine: head + i + 1, bLine: null })
          i += 1
        }
        while (j < m) {
          rows.push({ type: 'add', text: midB[j], aLine: null, bLine: head + j + 1 })
          j += 1
        }
      }

      for (let i = endA; i < a.length; i += 1) {
        rows.push({ type: 'same', text: a[i], aLine: i + 1, bLine: endB + (i - endA) + 1 })
      }
      return rows
    }

    /** Inline style objects reused across the tree and the viewer. */    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base, #0f1218)',
        color: 'var(--dsw-alias-label-primary, #e7ecf3)',
        font: '12px/1.5 var(--dsw-font-family, system-ui)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        height: '32px',
        padding: '0 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        flex: '0 0 auto',
        minWidth: 0,
        overflow: 'hidden',
      },
      iconBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '22px',
        height: '22px',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #98a3b3)',
        cursor: 'pointer',
        padding: 0,
      },
      crumb: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        font: '11.5px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        color: 'var(--dsw-alias-label-secondary, #98a3b3)',
      },
      body: { flex: 1, minHeight: 0, display: 'flex', position: 'relative' },
      tree: {
        width: '190px',
        flex: '0 0 190px',
        overflow: 'auto',
        borderRight: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        padding: '4px 4px 12px',
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        height: '24px',
        padding: '0 6px',
        borderRadius: '5px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        color: 'var(--dsw-alias-label-secondary, #98a3b3)',
        font: '11.5px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      chev: {
        width: '10px',
        flex: '0 0 10px',
        textAlign: 'center',
        opacity: 0.55,
        fontSize: '9px',
      },
      stripe: {
        width: '3px',
        flex: '0 0 3px',
        height: '11px',
        borderRadius: '2px',
        marginRight: '3px',
      },
      mark: {
        marginLeft: 'auto',
        paddingLeft: '5px',
        fontSize: '8px',
        lineHeight: 1,
        flex: '0 0 auto',
        color: 'var(--dsw-alias-state-warning-primary, #e8b339)',
      },
      strip: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 8px',
        overflowX: 'auto',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
        whiteSpace: 'nowrap',
      },
      chip: {
        flex: '0 0 auto',
        border: '1px solid transparent',
        borderRadius: '6px',
        padding: '1px 7px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #98a3b3)',
        font: '10.5px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        cursor: 'pointer',
      },
      column: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      prompt: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-state-success-primary, #3ddc97)',
        font: '11px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      cmd: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, #98a3b3)',
        font: '11px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      pill: {
        flex: '0 0 auto',
        borderRadius: '999px',
        padding: '0 7px',
        font: '10px/16px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        fontWeight: 600,
      },
      pillOk: { background: 'rgba(61,220,151,.16)', color: 'var(--dsw-alias-state-success-primary, #3ddc97)' },
      pillBad: { background: 'rgba(255,107,107,.16)', color: 'var(--dsw-alias-label-error, #ff6b6b)' },
      dur: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-tertiary, #7a8494)',
        font: '10px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      streamLabel: {
        padding: '4px 12px 0',
        color: 'var(--dsw-alias-label-tertiary, #7a8494)',
        fontSize: '10px',
        letterSpacing: '.06em',
        textTransform: 'uppercase',
      },
      menu: {
        position: 'fixed',
        zIndex: 60,
        minWidth: '150px',
        padding: '4px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        background: 'var(--dsw-alias-bg-layer-2, #171d27)',
        boxShadow: '0 8px 24px rgba(0,0,0,.35)',
      },
      menuItem: {
        display: 'block',
        width: '100%',
        border: 'none',
        borderRadius: '5px',
        padding: '5px 8px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #e7ecf3)',
        font: '11.5px system-ui',
        textAlign: 'left',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      menuSep: { height: '1px', margin: '4px 2px', background: 'var(--dsw-alias-border-l1, #1c222c)' },
      diffNote: {
        padding: '6px 12px',
        color: 'var(--dsw-alias-state-warning-primary, #e8b339)',
        fontSize: '11px',
        lineHeight: 1.6,
      },
      code: {
        flex: 1,
        minWidth: 0,
        overflow: 'auto',
        font: '12px/1.7 var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        padding: '6px 0 24px',
      },
      // The editor is a transparent textarea layered over a highlighted <pre>,
      // so both share one set of metrics. Fixed pixel line-height keeps the
      // glyph rows and the gutter rows locked together.
      editorShell: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base, #0f1218)' },
      editorRow: { flex: 1, minHeight: 0, display: 'flex', position: 'relative' },
      editorGutter: {
        flex: '0 0 46px',
        width: '46px',
        overflow: 'hidden',
        paddingTop: '8px',
        textAlign: 'right',
        borderRight: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        background: 'var(--dsw-alias-bg-base, #0f1218)',
        color: 'var(--dsw-alias-label-tertiary, #5d6775)',
        userSelect: 'none',
        font: '12px/20px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      editorGutterLine: { paddingRight: '9px', height: '20px' },
      editorPane: { position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden' },
      editorOverlay: {
        position: 'absolute',
        inset: 0,
        margin: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        whiteSpace: 'pre',
        font: '12px/20px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        padding: '8px 12px 24px',
        tabSize: 4,
        color: 'var(--dsw-alias-label-primary, #e7ecf3)',
      },
      editorArea: {
        position: 'relative',
        display: 'block',
        width: '100%',
        height: '100%',
        margin: 0,
        resize: 'none',
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: 'transparent',
        caretColor: 'var(--dsw-alias-label-primary, #e7ecf3)',
        whiteSpace: 'pre',
        overflow: 'auto',
        font: '12px/20px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        padding: '8px 12px 24px',
        tabSize: 4,
      },
      statusBar: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        height: '22px',
        padding: '0 10px',
        borderTop: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        color: 'var(--dsw-alias-label-tertiary, #7a8494)',
        font: '11px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
      },
      refBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        minHeight: '32px',
        padding: '4px 8px',
        borderTop: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
      },
      refChip: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        border: '1px solid rgba(140,110,255,.35)',
        borderRadius: '7px',
        padding: '3px 7px',
        color: 'var(--dsw-alias-label-primary, #e7ecf3)',
        background: 'rgba(126,87,255,.12)',
        font: '11px/1.4 var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      drawer: {
        flex: '0 0 auto',
        maxHeight: '38%',
        overflow: 'auto',
        borderTop: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
        font: '11.5px/1.65 var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      drawerHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 10px',
        position: 'sticky',
        top: 0,
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
      },
      out: { margin: 0, padding: '0 12px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      gutter: {
        display: 'inline-block',
        width: '34px',
        textAlign: 'right',
        paddingRight: '10px',
        color: 'var(--dsw-alias-label-tertiary, #5d6775)',
        userSelect: 'none',
        verticalAlign: 'top',
      },
      line: { whiteSpace: 'pre', minHeight: '20px' },
      diffLine: { whiteSpace: 'pre', minHeight: '20px', display: 'flex' },
      diffSign: {
        width: '16px',
        flex: '0 0 16px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary, #5d6775)',
        userSelect: 'none',
      },
      gapLine: {
        color: 'var(--dsw-alias-label-tertiary, #5d6775)',
        textAlign: 'center',
        padding: '2px 0',
        fontSize: '10.5px',
        letterSpacing: '.04em',
      },
      empty: {
        padding: '26px 16px',
        color: 'var(--dsw-alias-label-tertiary, #7a8494)',
        textAlign: 'center',
        lineHeight: 1.8,
        fontSize: '12px',
      },
      // The idle state has to earn its space: a bare "pick a file" line in a
      // 700px column reads as a broken panel.
      emptyWrap: {
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '34px 20px',
        overflow: 'auto',
      },
      emptyInner: { width: '100%', maxWidth: '340px', minWidth: 0 },
      emptyTitle: {
        fontSize: '13px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary, #e7ecf3)',
        marginBottom: '6px',
      },
      emptyHint: {
        fontSize: '11.5px',
        lineHeight: 1.7,
        color: 'var(--dsw-alias-label-tertiary, #7a8494)',
        marginBottom: '20px',
      },
      emptyLabel: {
        fontSize: '10px',
        letterSpacing: '.07em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary, #7a8494)',
        marginBottom: '7px',
      },
      emptyValue: {
        fontSize: '11px',
        fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        color: 'var(--dsw-alias-label-secondary, #98a3b3)',
        wordBreak: 'break-all',
        lineHeight: 1.6,
      },
      emptyBlock: { marginTop: '18px' },
      recentRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        height: '22px',
        padding: '0 5px',
        borderRadius: '5px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, #98a3b3)',
        font: '11.5px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      recentDir: {
        marginLeft: 'auto',
        paddingLeft: '10px',
        fontSize: '10px',
        color: 'var(--dsw-alias-label-tertiary, #7a8494)',
        opacity: 0.75,
        flex: '0 0 auto',
        maxWidth: '110px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    }

    /**
     * Styles for the rendered Markdown view.
     *
     * Kept separate from `S` because it is a document, not a control surface:
     * wider line height, real heading steps, and tables that scroll instead of
     * pushing the pane sideways.
     */
    const MD = {
      root: {
        flex: 1,
        minWidth: 0,
        overflow: 'auto',
        padding: '12px 16px 32px',
        fontSize: '12.5px',
        lineHeight: 1.75,
        color: 'var(--dsw-alias-label-primary, #e7ecf3)',
        wordBreak: 'break-word',
      },
      h1: { fontSize: '19px', fontWeight: 600, margin: '6px 0 10px', lineHeight: 1.35 },
      h2: { fontSize: '16px', fontWeight: 600, margin: '18px 0 8px', lineHeight: 1.4 },
      h3: { fontSize: '14px', fontWeight: 600, margin: '16px 0 6px' },
      h4: { fontSize: '13px', fontWeight: 600, margin: '14px 0 6px' },
      h5: { fontSize: '12.5px', fontWeight: 600, margin: '12px 0 4px' },
      h6: { fontSize: '12px', fontWeight: 600, margin: '12px 0 4px', opacity: 0.8 },
      p: { margin: '0 0 10px' },
      list: { margin: '0 0 10px', paddingLeft: '20px' },
      li: { margin: '2px 0' },
      check: { marginRight: '5px', opacity: 0.8 },
      quote: {
        margin: '0 0 10px',
        padding: '2px 0 2px 10px',
        borderLeft: '3px solid var(--dsw-alias-border-l2, #2a3140)',
        color: 'var(--dsw-alias-label-secondary, #98a3b3)',
      },
      fence: {
        margin: '0 0 12px',
        padding: '9px 11px',
        overflowX: 'auto',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
        font: '11.5px/1.6 var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        whiteSpace: 'pre',
      },
      codeInline: {
        padding: '1px 4px',
        borderRadius: '4px',
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
        font: '11.5px var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        color: 'var(--dsw-alias-state-warning-primary, #e8b339)',
      },
      link: { color: 'var(--dsw-alias-state-accent-primary, #9c83ff)', textDecoration: 'none' },
      math: {
        fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        whiteSpace: 'nowrap',
        padding: '0 1px',
      },
      mathBlock: {
        margin: '2px 0 12px',
        padding: '8px 10px',
        textAlign: 'center',
        overflowX: 'auto',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-1, #141922)',
        fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
        fontSize: '12.5px',
      },
      hr: {
        height: '1px',
        margin: '14px 0',
        background: 'var(--dsw-alias-border-l1, #1c222c)',
      },
      table: {
        margin: '0 0 12px',
        borderCollapse: 'collapse',
        display: 'block',
        overflowX: 'auto',
        maxWidth: '100%',
        fontSize: '11.5px',
      },
      th: {
        padding: '4px 9px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #2a3140)',
        textAlign: 'left',
        whiteSpace: 'nowrap',
        fontWeight: 600,
      },
      td: {
        padding: '4px 9px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #1c222c)',
        verticalAlign: 'top',
      },
    }

    // ────────────────────────────── components ────────────────────────────

    /**
     * Build the tab body bound to this plugin context.
     * @param getRemote - reads the Client Remote face.
     * @returns the body component for `sidebar.right.pane.tab`.
     */
    function makeBody(getRemote, layout) {
      /**
       * @param props - framework props: the owning session and the tab hook.
       */
      return function CodeBody(props) {
        const { sessionId, sessions, inputActions, useTabInfo } = props
        const remote = getRemote()

        // A tab opened from a chat file reference carries that file's address;
        // one opened from the guide card carries a page address instead, which
        // parses to null and leaves the pane on its normal tree.
        const tab = typeof useTabInfo === 'function' ? useTabInfo() : null
        const tabContentId = tab && tab.tab ? tab.tab.contentId : undefined
        const addressed = React.useMemo(() => parseFileAddress(tabContentId), [tabContentId])

        /** Session this tab reads from: the address's, else the slot's, else the store's. */
        const sid = (addressed && addressed.sessionId) || sessionId || currentSessionId(sessions)

        /** The session working directory; `.` when the store has no row yet. */
        const root = React.useMemo(() => {
          try {
            const store = sessions
            const list = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : store
            const entry = list && list.byId ? list.byId[sid] : undefined
            const cwd = entry && typeof entry.cwd === 'string' ? entry.cwd : ''
            return cwd || '.'
          } catch {
            return '.'
          }
        }, [sessions, sid])

        const [treeOpen, setTreeOpen] = React.useState(true)
        const [levels, setLevels] = React.useState({})
        const [expanded, setExpanded] = React.useState(() => new Set())
        const [openPath, setOpenPath] = React.useState(null)
        const [file, setFile] = React.useState(null)
        const [notice, setNotice] = React.useState('')
        const [draft, setDraft] = React.useState(null)
        const [selectionRef, setSelectionRef] = React.useState(null)
        const [conflict, setConflict] = React.useState(null)
        const [diffOpen, setDiffOpen] = React.useState(false)
        const [conflictDiff, setConflictDiff] = React.useState(false)
        const [editIndex, setEditIndex] = React.useState({})
        const [editPick, setEditPick] = React.useState(null)
        const [editBody, setEditBody] = React.useState(null)
        const [showAllEdits, setShowAllEdits] = React.useState(false)
        const [mdRendered, setMdRendered] = React.useState(true)
        const [menu, setMenu] = React.useState(null)
        const [run, setRun] = React.useState(null)
        const [running, setRunning] = React.useState(false)
        const versionRef = React.useRef(null)
        const contentVersionRef = React.useRef(null)
        const rootRef = React.useRef(null)
        const runAbortRef = React.useRef(null)
        const editorRef = React.useRef(null)
        const overlayRef = React.useRef(null)
        const gutterRef = React.useRef(null)
        const [caret, setCaret] = React.useState({ line: 1, col: 1 })

        /** Writing and running need a real absolute root; `.` cannot be addressed by the host. */
        const canWrite = /^([A-Za-z]:[\\/]|\/)/.test(root)

        /**
         * POST one action to this plugin's own host routes.
         * @param action - `write` or `run`.
         * @param body - JSON payload.
         */
        const callHost = React.useCallback(
          async (action, body) => {
            const response = await fetch(`${ROUTE_PREFIX}/${action}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-dsh-ide-pane': '1' },
              body: JSON.stringify(body),
            })
            const text = await response.text()
            try {
              return JSON.parse(text)
            } catch {
              throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`)
            }
          },
          [],
        )

        /** Save the draft back to disk, but never overwrite a version unseen by the editor. */
        const saveDraft = React.useCallback(async () => {
          if (draft === null || openPath === null) return
          if (!canWrite) {
            setNotice('没有绝对工作目录，无法保存')
            return
          }
          try {
            const result = await callHost('write', {
              root,
              path: openPath,
              text: draft,
              baseVersion: contentVersionRef.current,
            })
            if (result && result.conflict === true) {
              setConflict({
                path: openPath,
                diskText: typeof result.currentText === 'string' ? result.currentText : '',
                diskVersion: result.currentVersion === null ? null : result.currentVersion,
              })
              setNotice('保存冲突：Agent 已改动文件')
              return
            }
            if (!result || result.ok !== true) {
              setNotice(`保存失败：${(result && result.error) || '未知错误'}`)
              return
            }
            contentVersionRef.current = result.version
            setConflict(null)
            setDraft(null)
            setSelectionRef(null)
            setNotice('已保存')
            // No baseline bookkeeping here: the reload that follows observes the
            // new text and records the old one as its comparison point, exactly
            // as it would for any other change.
            loadFileRef.current(openPath)
          } catch (error) {
            setNotice(`保存失败：${(error && error.message) || error}`)
          }
        }, [draft, openPath, canWrite, root, callHost, sid])

        /**
         * Run the open file, streaming its output.
         *
         * The stream is this plugin's own `text/event-stream` route: the browser
         * reads the response body incrementally, so output appears as the child
         * produces it, and aborting the fetch closes the response, which is what
         * makes the Host kill the process.
         */
        const runFile = React.useCallback(async () => {
          if (openPath === null || running) return
          if (!canWrite) {
            setNotice('没有绝对工作目录，无法运行')
            return
          }

          const command = planRunCommand(openPath)
          const abort = new AbortController()
          runAbortRef.current = abort
          setRunning(true)
          setNotice('')
          // The drawer opens on the click, not on the first byte: an empty pane
          // during a slow start is indistinguishable from a dead button.
          setRun({ command, text: '正在启动…', state: 'starting', exitCode: null, ms: 0, stream: true })

          let text = ''
          try {
            const response = await fetch(`${ROUTE_PREFIX}/runStream`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-dsh-ide-pane': '1' },
              body: JSON.stringify({ root, path: openPath }),
              signal: abort.signal,
            })
            if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              let cut = buffer.indexOf('\n\n')
              while (cut !== -1) {
                const raw = buffer.slice(0, cut)
                buffer = buffer.slice(cut + 2)
                cut = buffer.indexOf('\n\n')
                if (!raw.startsWith('data: ')) continue
                let frame
                try {
                  frame = JSON.parse(raw.slice(6))
                } catch {
                  continue
                }
                if (frame.type === 'start') {
                  setRun((prev) => (prev ? { ...prev, command: frame.command || prev.command, state: 'running', text } : prev))
                } else if (frame.type === 'out' || frame.type === 'err') {
                  text += frame.text || ''
                  const shown = applyCarriageReturns(sanitizeTerminal(text))
                  setRun((prev) => (prev ? { ...prev, text: shown, state: 'running' } : prev))
                } else if (frame.type === 'end') {
                  setRun((prev) =>
                    prev ? { ...prev, text: applyCarriageReturns(sanitizeTerminal(text)), state: 'exited', exitCode: frame.code ?? null, ms: frame.ms ?? 0 } : prev,
                  )
                } else if (frame.type === 'fail') {
                  text += `${frame.error || '运行失败'}\n`
                  setRun((prev) => (prev ? { ...prev, text, state: 'failed' } : prev))
                }
              }
            }
          } catch (error) {
            if (abort.signal.aborted) {
              setRun((prev) => (prev ? { ...prev, state: 'exited', text: prev.text || '已停止' } : prev))
              setNotice('已停止')
            } else {
              const message = String((error && error.message) || error)
              setRun((prev) => (prev ? { ...prev, text: `${prev.text || ''}运行失败：${message}`, state: 'failed' } : prev))
            }
          } finally {
            runAbortRef.current = null
            setRunning(false)
          }
        }, [openPath, running, canWrite, root])

        /** Stop the running child by closing the stream it is writing to. */
        const stopRun = React.useCallback(() => {
          const abort = runAbortRef.current
          if (abort === null) {
            setRunning(false)
            setRun((prev) => (prev ? { ...prev, state: 'exited' } : prev))
            return
          }
          abort.abort()
        }, [])

        /** Load one directory level. */
        const loadLevel = React.useCallback(
          async (path) => {
            if (!remote || !remote.workspaceFiles) {
              const names = remote && typeof remote === 'object' ? Object.keys(remote).join(',') : '无 remote'
              setLevels((prev) => ({ ...prev, [path]: { status: 'error', message: `没有 workspaceFiles（${names}）` } }))
              return
            }
            if (!sid) {
              setLevels((prev) => ({ ...prev, [path]: { status: 'error', message: '没有 sessionId' } }))
              return
            }
            setLevels((prev) => ({ ...prev, [path]: { status: 'loading' } }))
            try {
              const result = await withTimeout(remote.workspaceFiles.list(sid, path), 6000, 'list ')
              if (!result || !result.ok) {
                console.warn('[dsh-ide-pane] list failed', path, result && result.error)
                const code = result && result.error && result.error.code
                // A rejected absolute cwd is recoverable: address the workspace
                // root relatively instead of giving up on the whole pane.
                if (path === root && root !== '.' && typeof code === 'string' && /not-found|bad-request|outside-workspace|unknown-workspace/.test(code)) {
                  console.info('[dsh-ide-pane] root rejected, retrying from "."', code)
                  await loadLevelRef.current('.')
                  return
                }
                setLevels((prev) => ({ ...prev, [path]: { status: 'error', message: failureText(result) } }))
                return
              }
              const entries = (result.value.entries || [])
                .slice()
                .sort((a, b) => {
                  const da = isDir(a) ? 0 : 1
                  const db = isDir(b) ? 0 : 1
                  if (da !== db) return da - db
                  return String(a.name).localeCompare(String(b.name))
                })
              setLevels((prev) => ({ ...prev, [path]: { status: 'ready', entries } }))
            } catch (error) {
              console.error('[dsh-ide-pane] list threw', path, error)
              setLevels((prev) => ({
                ...prev,
                [path]: { status: 'error', message: String((error && error.message) || error) },
              }))
            }
          },
          [remote, sid],
        )

        /** Late-bound handle so a failed root listing can retry through itself. */
        const loadLevelRef = React.useRef(loadLevel)
        loadLevelRef.current = loadLevel

        /**
         * Load the open file's text.
         * @param path - file to read.
         */
        const loadFile = React.useCallback(
          async (path) => {
            if (!remote || !sid || path === null) return
            try {
              const result = await remote.workspaceFiles.read(sid, path, { offset: 1, limit: MAX_LINES })
              if (!result || !result.ok) {
                setFile({ path, error: failureText(result) })
                versionRef.current = null
                return
              }
              const value = result.value
              versionRef.current = value.version
              if (canWrite) {
                try {
                  const info = await callHost('stat', { root, path })
                  contentVersionRef.current = info && info.ok === true ? info.version : undefined
                } catch {
                  contentVersionRef.current = undefined
                }
              } else {
                contentVersionRef.current = undefined
              }
              setConflict(null)
              setSelectionRef(null)
              const text = value.text || ''
              // The comparison point is the text this pane saw immediately
              // before, and it lives in storage rather than in this component,
              // so closing the diff, switching tabs, or reloading the page all
              // reopen on the same comparison.
              const observed = observeVersion(sid, path, text)
              setFile({
                path,
                text,
                baseText: observed.prev === null ? text : observed.prev,
                truncated: value.eof === false,
                total: value.lines,
                error: null,
              })
            } catch (error) {
              setFile({ path, error: String(error && error.message) })
              versionRef.current = null
            }
          },
          [remote, sid, canWrite, callHost, root],
        )

        /** Late-bound handle so a save can reload through the same path. */
        const loadFileRef = React.useRef(loadFile)
        loadFileRef.current = loadFile

        // Root listing. Key-guarded: a re-render must never re-run the boot
        // sequence, or a state reset would race the in-flight listing forever.
        const bootRef = React.useRef(null)
        React.useEffect(() => {
          if (!sid) {
            setLevels({ '': { status: 'error', message: '这个标签页没有绑定会话' } })
            return
          }
          const boot = `${sid}\u0000${root}`
          if (bootRef.current === boot) return
          bootRef.current = boot
          console.info('[dsh-ide-pane] boot', {
            sid,
            root,
            hasRemote: Boolean(remote),
            hasNamespace: Boolean(remote && remote.workspaceFiles),
          })
          setLevels({})
          setExpanded(new Set())
          setOpenPath(null)
          setFile(null)
          loadLevel(root)
        }, [sid, root, loadLevel])

        // Open file when the selection changes.
        React.useEffect(() => {
          if (openPath === null) return
          setNotice('')
          setEditPick(null)
          setShowAllEdits(false)
          loadFile(openPath)
        }, [openPath, loadFile])

        // A tab addressed at one file starts on that file. The boot effect runs
        // first and clears `openPath`, so this is declared after it.
        const seededRef = React.useRef(null)
        React.useEffect(() => {
          if (addressed === null) return
          const key = `${addressed.sessionId || ''}\u0000${addressed.path}`
          if (seededRef.current === key) return
          seededRef.current = key
          setDiffOpen(false)
          setEditPick(null)
          setOpenPath(addressed.path)
        }, [addressed])

        // Follow the open file: the Agent may rewrite it while it is on screen.
        //
        // The first-party `stat` is the intended freshness token, but a Remote
        // that is missing, refused, or simply never answers must not leave the
        // pane silently frozen — that reads as "the diff is broken". Each tick
        // therefore falls back to this plugin's own content hash, and gives up
        // loudly after a few failures instead of pretending nothing happened.
        React.useEffect(() => {
          if (!remote || !sid || openPath === null) return undefined
          let alive = true
          let probeSource = 'remote'
          let failures = 0

          const probe = async () => {
            try {
              const result = await remote.workspaceFiles.stat(sid, openPath)
              if (result && result.ok && result.value && result.value.version !== undefined) {
                return { version: result.value.version, source: 'remote' }
              }
            } catch {
              /* fall through to the local probe */
            }
            if (!canWrite) return null
            try {
              const result = await callHost('stat', { root, path: openPath })
              if (result && result.ok === true) return { version: result.version, source: 'host' }
            } catch {
              /* both probes failed; reported below */
            }
            return null
          }

          const timer = setInterval(async () => {
            const found = await probe()
            if (!alive) return
            if (found === null) {
              failures += 1
              if (failures === 3) setNotice('无法检测文件变化')
              return
            }
            failures = 0
            // Two probes spell the same file differently; adopting a new source
            // must not look like an edit.
            if (probeSource !== found.source) {
              probeSource = found.source
              versionRef.current = found.version
              return
            }
            if (versionRef.current !== null && found.version !== versionRef.current) {
              versionRef.current = found.version
              setNotice('文件已更新')
              loadFile(openPath)
            }
          }, POLL_MS)

          return () => {
            alive = false
            clearInterval(timer)
          }
        }, [remote, sid, openPath, loadFile, canWrite, callHost, root])

        // What the Agent wrote in this Session, refreshed slowly: the summary is
        // small and only changes when a tool runs.
        React.useEffect(() => {
          if (!sid) return undefined
          let alive = true
          const load = async () => {
            try {
              const result = await callHost('edits', { sessionId: sid })
              if (!alive) return
              if (result && result.ok === true && result.files && typeof result.files === 'object') {
                setEditIndex(result.files)
              }
            } catch {
              /* the log may be unavailable; the tree simply shows no markers */
            }
          }
          load()
          const timer = setInterval(load, 4000)
          return () => {
            alive = false
            clearInterval(timer)
          }
        }, [sid, callHost])

        // The body of a picked edit is fetched only when it is actually shown.
        React.useEffect(() => {
          if (editPick === null) {
            setEditBody(null)
            return undefined
          }
          let alive = true
          setEditBody({ loading: true })
          const load = async () => {
            try {
              const result = await callHost('editText', { sessionId: sid, seq: editPick.seq })
              if (!alive) return
              if (result && result.ok === true) {
                setEditBody({ loading: false, old: result.old, new: result.new, kind: result.kind })
              } else {
                setEditBody({ loading: false, error: (result && result.error) || '读取失败' })
              }
            } catch (error) {
              if (alive) setEditBody({ loading: false, error: String((error && error.message) || error) })
            }
          }
          load()
          return () => {
            alive = false
          }
        }, [editPick, sid, callHost])

        /** Files and directories carrying at least one recorded Agent edit. */
        const marks = React.useMemo(() => {
          const files = new Set()
          const dirs = new Set()
          for (const [key, list] of Object.entries(editIndex)) {
            if (!Array.isArray(list) || list.length === 0) continue
            const full = resolveForCompare(key, root)
            files.add(full)
            let cut = full.lastIndexOf('/')
            while (cut > 0) {
              const parent = full.slice(0, cut)
              if (dirs.has(parent)) break
              dirs.add(parent)
              cut = parent.lastIndexOf('/')
            }
          }
          return { files, dirs }
        }, [editIndex, root])

        /** Recorded edits for the open file, oldest first. */
        const fileEdits = React.useMemo(() => {
          if (!openPath) return []
          const target = normPath(openPath)
          for (const [key, list] of Object.entries(editIndex)) {
            if (!Array.isArray(list) || list.length === 0) continue
            if (resolveForCompare(key, root) === target) return list
          }
          return []
        }, [editIndex, openPath, root])

        /** Toggle a directory row. */
        const onToggle = React.useCallback(
          (path) => {
            setExpanded((prev) => {
              const next = new Set(prev)
              if (next.has(path)) next.delete(path)
              else {
                next.add(path)
                if (!levels[path]) loadLevel(path)
              }
              return next
            })
          },
          [levels, loadLevel],
        )

        /** Render one directory level and its open children. */
        const renderLevel = (path, depth) => {
          const level = levels[path]
          if (!level || level.status === 'loading') {
            return [h('div', { key: `${path}:loading`, style: { ...S.row, paddingLeft: `${6 + depth * 11}px`, color: 'var(--dsw-alias-label-tertiary, #6b7684)' } }, '载入中…')]
          }
          if (level.status === 'error') {
            return [h('div', { key: `${path}:err`, style: { ...S.row, paddingLeft: `${6 + depth * 11}px`, color: 'var(--dsw-alias-label-error, #ff6b6b)' } }, level.message || '失败')]
          }
          const rows = []
          for (const entry of level.entries) {
            const full = childPath(path, entry.name)
            const dir = isDir(entry)
            const isOpen = expanded.has(full)
            const selected = !dir && full === openPath
            const accent = dir ? null : accentOf(entry.name)
            const { base, ext } = splitName(entry.name)
            const changed = dir ? marks.dirs.has(normPath(full)) : marks.files.has(normPath(full))
            rows.push(
              h(
                'div',
                {
                  key: full,
                  'data-ide-row': '',
                  style: {
                    ...S.row,
                    paddingLeft: `${4 + depth * 12}px`,
                    background: selected ? 'var(--dsw-alias-interactive-bg-active, rgba(91,140,255,.14))' : 'transparent',
                    color: selected || dir ? 'var(--dsw-alias-label-primary, #e7ecf3)' : 'var(--dsw-alias-label-secondary, #98a3b3)',
                  },
                  onClick: () => (dir ? onToggle(full) : setOpenPath(full)),
                  onContextMenu: dir ? undefined : (event) => openMenu(event, full),
                  draggable: !dir,
                  onDragStart: dir ? undefined : (event) => beginDrag(event, full),
                  title: changed ? `${full}\n（Agent 改动过）` : full,
                },
                h('span', { style: S.chev }, dir ? (isOpen ? '▾' : '▸') : ''),
                h('span', { style: { ...S.stripe, background: accent || 'transparent' } }),
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                  base,
                  ext ? h('span', { style: { opacity: 0.5 } }, ext) : null,
                ),
                changed
                  ? h('span', { style: dir ? { ...S.mark, opacity: 0.55 } : S.mark }, '●')
                  : null,
              ),
            )
            if (dir && isOpen) rows.push(...renderLevel(full, depth + 1))
          }
          if (rows.length === 0) {
            rows.push(h('div', { key: `${path}:empty`, style: { ...S.row, paddingLeft: `${6 + depth * 11}px`, opacity: 0.6 } }, '（空）'))
          }
          return rows
        }

        /**
         * Render a line diff with two unchanged lines of context around each
         * change, collapsing long untouched stretches.
         * @param before - older text.
         * @param after - newer text.
         */
        const renderDiff = (before, after) => {
          const rows = diffLines(before, after)
          const changed = []
          for (let i = 0; i < rows.length; i += 1) if (rows[i].type !== 'same') changed.push(i)
          if (changed.length === 0) return [h('div', { key: 'nodiff', style: S.empty }, '两边内容相同')]

          const keep = new Set()
          for (const index of changed) {
            for (let delta = -2; delta <= 2; delta += 1) {
              const at = index + delta
              if (at >= 0 && at < rows.length) keep.add(at)
            }
          }

          const out = []
          let i = 0
          while (i < rows.length) {
            if (keep.has(i)) {
              const row = rows[i]
              const added = row.type === 'add'
              const removed = row.type === 'del'
              out.push(
                h(
                  'div',
                  {
                    key: `d${i}`,
                    style: {
                      ...S.diffLine,
                      background: added
                        ? 'rgba(61,220,151,.10)'
                        : removed
                          ? 'rgba(255,107,107,.10)'
                          : 'transparent',
                    },
                  },
                  h('span', { style: { ...S.gutter, width: '30px' } }, String(row.bLine === null ? row.aLine : row.bLine)),
                  h('span', { style: { ...S.diffSign, color: added ? 'var(--dsw-alias-state-success-primary, #3ddc97)' : removed ? 'var(--dsw-alias-label-error, #ff6b6b)' : 'var(--dsw-alias-label-tertiary, #5d6775)' } }, added ? '+' : removed ? '-' : ' '),
                  h('span', null, row.text === '' ? ' ' : row.text),
                ),
              )
              i += 1
              continue
            }
            let j = i
            while (j < rows.length && !keep.has(j)) j += 1
            out.push(h('div', { key: `g${i}`, style: { ...S.line, ...S.gapLine } }, `··· ${j - i} 行未变 ···`))
            i = j
          }
          return out
        }

        /** The idle state: where this workspace is, and what you looked at last. */
        const renderIdle = () => {
          const recents = sid ? recentBaselines(sid, 5) : []
          return h(
            'div',
            { style: S.emptyWrap },
            h(
              'div',
              { style: S.emptyInner },
              h('div', { style: S.emptyTitle }, '从左侧选择一个文件'),
              h('div', { style: S.emptyHint }, '打开后可以编辑、运行；Agent 改动会在 2 秒内反映到这里，并给出差异。'),
              h(
                'div',
                null,
                h('div', { style: S.emptyLabel }, '工作区'),
                h('div', { style: S.emptyValue, title: root }, root === '.' ? '未绑定会话目录（只读）' : root),
              ),
              recents.length > 0
                ? h(
                    'div',
                    { style: S.emptyBlock },
                    h('div', { style: S.emptyLabel }, '最近打开'),
                    recents.map((row) =>
                      h(
                        'div',
                        {
                          key: row.path,
                          'data-ide-row': '',
                          style: S.recentRow,
                          title: row.path,
                          onClick: () => setOpenPath(row.path),
                          onContextMenu: (event) => openMenu(event, row.path),
                          draggable: true,
                          onDragStart: (event) => beginDrag(event, row.path),
                        },
                        h('span', { style: { ...S.stripe, background: accentOf(row.path) || 'transparent' } }),
                        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, baseNameOf(row.path)),
                        h('span', { style: S.recentDir }, baseNameOf(dirNameOf(row.path))),
                      ),
                    ),
                  )
                : null,
            ),
          )
        }

        /** Render the code area. */
        const renderCode = () => {
          if (openPath === null) return renderIdle()
          if (!file || file.path !== openPath) return h('div', { style: S.empty }, '载入中…')
          if (file.error) return h('div', { style: { ...S.empty, color: 'var(--dsw-alias-label-error, #ff6b6b)' } }, file.error)

          // Markdown defaults to its rendered form; the toggle below the bar
          // switches back to the source the editor works on.
          if (isMarkdown(openPath) && mdRendered) {
            const nodes = renderMarkdown(h, file.text || '')
            if (nodes.length === 0) return h('div', { style: S.empty }, '（空文档）')
            return h('div', { key: 'md', style: MD.root }, nodes)
          }

          const lang = langOf(openPath)
          const lines = (file.text || '').split('\n')
          const rows = []
          for (let i = 0; i < lines.length; i += 1) {
            const tokens = tokenize(lines[i], lang)
            rows.push(
              h(
                'div',
                { key: i, style: S.line },
                h('span', { style: S.gutter }, String(i + 1)),
                h(
                  'span',
                  null,
                  tokens.map((token, index) =>
                    token.kind === 'plain' || token.kind === 'space' || token.kind === 'ident'
                      ? token.text
                      : h('span', { key: index, style: { color: TOKEN_COLOR[token.kind] } }, token.text),
                  ),
                ),
              ),
            )
          }
          if (file.truncated) {
            rows.push(h('div', { key: 'more', style: { ...S.empty, paddingTop: '10px' } }, `仅显示前 ${MAX_LINES} 行`))
          }
          return rows
        }

        /** Short label for one recorded edit. */
        const editLabel = (edit, index) => {
          let time = ''
          try {
            time = new Date(edit.at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
          } catch {
            time = ''
          }
          const kind = edit.kind === 'write' ? '写入' : edit.kind === 'replace' ? '编辑' : '改动'
          return `${index + 1} · ${time} ${kind}`
        }

        /** Pick between the file as it stands and any recorded Agent edit. */
        const renderEditStrip = () => {
          const active = editPick ? editPick.seq : diffOpen && hasAgentEdits ? 'baseline' : 'current'
          // A long session can record hundreds of edits to one file; showing
          // them all buries the recent ones the reader actually came for.
          const start = showAllEdits ? 0 : Math.max(0, fileEdits.length - EDIT_STRIP_LIMIT)
          const hidden = start
          const chip = (key, label, onClick, extra) =>
            h(
              'button',
              {
                key: String(key),
                'data-ide-chip': '',
                style: active === key
                  ? {
                      ...S.chip,
                      ...extra,
                      background: 'var(--dsw-alias-interactive-bg-active, rgba(91,140,255,.14))',
                      borderColor: 'rgba(91,140,255,.35)',
                      color: 'var(--dsw-alias-label-primary, #e7ecf3)',
                    }
                  : { ...S.chip, ...extra },
                onClick,
              },
              label,
            )
          return h(
            'div',
            { style: S.strip },
            chip('current', '当前内容', () => {
              setEditPick(null)
              setDiffOpen(false)
            }),
            hasAgentEdits
              ? chip('baseline', '与基线比较', () => {
                  setEditPick(null)
                  setDiffOpen(true)
                })
              : null,
            hidden > 0
              ? chip(
                  'older',
                  `更早 ${hidden} 条`,
                  () => setShowAllEdits(true),
                  { opacity: 0.7 },
                )
              : null,
            fileEdits
              .slice(start)
              .map((edit, offset) => chip(edit.seq, editLabel(edit, start + offset), () => setEditPick({ ...edit }))),
          )
        }

        /** The code column: a picked edit, the baseline diff, or the file. */
        const renderMain = () => {
          if (editPick) {
            if (!editBody) return h('div', { style: S.empty }, '载入中…')
            if (editBody.error) {
              return h('div', { style: { ...S.empty, color: 'var(--dsw-alias-label-error, #ff6b6b)' } }, editBody.error)
            }
            const note = editBody.kind === 'write'
              ? '整体写入：日志里没有旧内容，下面只显示写入后的结果。'
              : null
            return [
              note ? h('div', { key: 'note', style: S.diffNote }, note) : null,
              ...renderDiff(editBody.old === null ? '' : editBody.old, editBody.new === null ? '' : editBody.new),
            ]
          }
          if (diffOpen && file && typeof file.baseText === 'string') return renderDiff(file.baseText, file.text)
          return renderCode()
        }

        // Hand the layout to the IDE while this pane is actually on screen, and
        // give it back when the tab closes, is switched away from, or the user
        // reopens the sidebar by hand. The sidebar itself is collapsed through
        // the host's own layout service, so its rail and its shortcut keep
        // working; the stylesheet only re-weights the three frame columns.
        React.useEffect(() => {
          const element = rootRef.current
          if (!element || !layout || typeof IntersectionObserver === 'undefined') return undefined

          // CSS-module names are `<hash>_<name>`; match the exact suffix so a
          // `_frameSomething` class elsewhere cannot be mistaken for the shell.
          const frameElement = () => {
            for (const candidate of document.querySelectorAll('[class*="_frame"]')) {
              if (Array.from(candidate.classList).some((token) => token.endsWith('_frame'))) return candidate
            }
            return null
          }
          let wasVisible = false
          let collapsedByUs = false

          const collapse = () => {
            const frame = frameElement()
            if (!frame || frame.hasAttribute('data-sidebar-collapsed')) return false
            layout.toggleSidebar()
            return true
          }
          const restore = () => {
            if (!collapsedByUs) return
            collapsedByUs = false
            layout.toggleSidebar()
          }

          const observer = new IntersectionObserver(
            (entries) => {
              const visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)
              if (visible === wasVisible) return
              wasVisible = visible
              document.documentElement.toggleAttribute(DOMINANT_ATTR, visible)
              if (visible) collapsedByUs = collapse()
              else restore()
            },
            { threshold: 0.01 },
          )
          observer.observe(element)

          // The user reopening the sidebar by hand ends the takeover.
          const frame = frameElement()
          const watcher =
            typeof MutationObserver === 'undefined' || !frame
              ? null
              : new MutationObserver(() => {
                  if (frame.hasAttribute('data-sidebar-collapsed')) return
                  if (!document.documentElement.hasAttribute(DOMINANT_ATTR)) return
                  document.documentElement.removeAttribute(DOMINANT_ATTR)
                  collapsedByUs = false
                })
          if (watcher && frame) watcher.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })

          return () => {
            observer.disconnect()
            if (watcher) watcher.disconnect()
            document.documentElement.removeAttribute(DOMINANT_ATTR)
            restore()
          }
        }, [])

        const editing = draft !== null
        const hasAgentEdits = Boolean(file && typeof file.baseText === 'string' && file.baseText !== file.text)
        const smallBtn = (extra) => ({ ...S.iconBtn, width: 'auto', padding: '0 8px', ...extra })

        /** Keep the highlight overlay and the gutter glued to the textarea. */
        const syncEditorScroll = () => {
          const area = editorRef.current
          if (!area) return
          if (overlayRef.current) {
            overlayRef.current.scrollTop = area.scrollTop
            overlayRef.current.scrollLeft = area.scrollLeft
          }
          if (gutterRef.current) gutterRef.current.scrollTop = area.scrollTop
        }

        /** Move the status readout to the caret. */
        const updateCaret = (value, position) => {
          const before = String(value).slice(0, position)
          const line = before.split('\n').length
          const col = position - before.lastIndexOf('\n')
          setCaret({ line, col: Math.max(1, col) })
        }

        /** Drop four spaces in at the caret, keeping the caret after them. */
        const insertIndent = () => {
          const area = editorRef.current
          if (!area) return
          const start = area.selectionStart
          const end = area.selectionEnd
          const next = `${draft.slice(0, start)}    ${draft.slice(end)}`
          setDraft(next)
          requestAnimationFrame(() => {
            area.selectionStart = start + 4
            area.selectionEnd = start + 4
            updateCaret(next, start + 4)
          })
        }

        // A rewritten value can leave the overlay at the old offset.
        React.useEffect(syncEditorScroll, [draft])

        /**
         * The edit surface's coloured glyph layer.
         *
         * `null` means "too long to colour": the overlay then stays empty and
         * the textarea falls back to its own visible text, because a highlight
         * layer that lags a keystroke is worse than none.
         */
        const highlightLayer = React.useMemo(() => {
          if (draft === null) return []
          const lines = String(draft).split('\n')
          if (lines.length > MAX_HIGHLIGHT_LINES) return null
          const lang = openPath ? langOf(openPath) : 'txt'
          return lines.map((line, index) => {
            const tokens = tokenize(line, lang)
            return h(
              'div',
              { key: index, style: { height: '20px' } },
              tokens.map((token, i) =>
                token.kind === 'plain' || token.kind === 'space' || token.kind === 'ident'
                  ? token.text
                  : h('span', { key: i, style: { color: TOKEN_COLOR[token.kind] } }, token.text),
              ),
            )
          })
        }, [draft, openPath])

        const plainEditor = highlightLayer === null

        /**
         * Put a reference into the owning Session's composer.
         *
         * `inputActions.insertText` rides the host's own Lexical editor, so the
         * insertion is one undoable edit. If that seam refuses — the composer
         * moved its selection, or the tab is not bound — the reference is copied
         * instead of being lost.
         * @param text - the reference to insert.
         */
        const insertReference = React.useCallback(
          async (text) => {
            if (typeof text !== 'string' || text === '') return
            try {
              if (inputActions && typeof inputActions.insertText === 'function' && typeof inputActions.captureInsertion === 'function') {
                if (inputActions.insertText(`${text} `, inputActions.captureInsertion())) {
                  setNotice('已引用到对话')
                  return
                }
              }
              if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(text)
                setNotice('输入框已变化，引用已复制')
                return
              }
              setNotice(`引用：${text}`)
            } catch (error) {
              setNotice(`引用失败：${(error && error.message) || error}`)
            }
          },
          [inputActions],
        )

        /** Copy text to the clipboard, reporting what happened. */
        const copyText = React.useCallback(async (text, label) => {
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(text)
              setNotice(`已复制${label}`)
              return true
            }
            setNotice('这个环境不允许写剪贴板')
            return false
          } catch (error) {
            setNotice(`复制失败：${(error && error.message) || error}`)
            return false
          }
        }, [])

        /** Put the selected reference into the owning Session's composer. */
        const insertSelectionReference = async () => {
          if (!selectionRef) return
          await insertReference(selectionRef.text)
        }

        /**
         * A drop that started in this pane lands in the conversation.
         *
         * The target is the composer, which belongs to the shell, so the only
         * place to see the drop is the document. Handling it here (rather than
         * letting the editor read `text/plain`) keeps the reference atomic: the
         * text goes in through the composer's own insert seam, and the drop is
         * consumed so it cannot be inserted twice.
         */
        React.useEffect(() => {
          if (typeof document === 'undefined') return undefined
          const onDrop = (event) => {
            if (draggingReference === null) return
            const payload = draggingReference
            draggingReference = null
            // Dropping back onto the pane is a cancel, not a reference.
            if (rootRef.current && event.target instanceof Node && rootRef.current.contains(event.target)) return
            event.preventDefault()
            event.stopPropagation()
            insertReference(payload)
          }
          const onDragEnd = () => {
            draggingReference = null
          }
          document.addEventListener('drop', onDrop, true)
          document.addEventListener('dragend', onDragEnd, true)
          return () => {
            document.removeEventListener('drop', onDrop, true)
            document.removeEventListener('dragend', onDragEnd, true)
            draggingReference = null
          }
        }, [insertReference])

        /** Start dragging a file out of the tree. */
        const beginDrag = (event, path) => {
          const payload = fileReference(path)
          draggingReference = payload
          try {
            event.dataTransfer.setData('text/plain', payload)
            event.dataTransfer.effectAllowed = 'copy'
          } catch {
            /* a browser that refuses custom payloads still has the drop handler */
          }
        }

        /** Read a file's text for the copy action, reusing the open copy. */
        const readForCopy = async (path) => {
          if (file && file.path === path && typeof file.text === 'string') return file.text
          if (!remote || !sid) return null
          const result = await remote.workspaceFiles.read(sid, path, { offset: 1, limit: MAX_LINES })
          if (!result || !result.ok) return null
          return typeof result.value.text === 'string' ? result.value.text : null
        }

        /** Open the row menu at the pointer. */
        const openMenu = (event, path) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({ x: event.clientX, y: event.clientY, path })
        }

        /** Dismiss the row menu on the next click, Escape, or scroll. */
        React.useEffect(() => {
          if (menu === null || typeof document === 'undefined') return undefined
          const close = () => setMenu(null)
          const onKey = (event) => {
            if (event.key === 'Escape') setMenu(null)
          }
          // Deferred by a tick: the click that opened the menu is still in flight.
          const timer = setTimeout(() => {
            document.addEventListener('click', close)
            document.addEventListener('contextmenu', close)
            window.addEventListener('scroll', close, true)
          }, 0)
          document.addEventListener('keydown', onKey)
          return () => {
            clearTimeout(timer)
            document.removeEventListener('click', close)
            document.removeEventListener('contextmenu', close)
            window.removeEventListener('scroll', close, true)
            document.removeEventListener('keydown', onKey)
          }
        }, [menu])

        /**
         * One captured stream, with any SGR colours it carried.
         * @param text - the captured output.
         * @param tone - `out` keeps the normal colour, `err` tints everything red.
         */
        const renderOutput = (text, tone) => {
          const base = tone === 'err' ? { color: 'var(--dsw-alias-label-error, #ff6b6b)' } : null
          const style = base === null ? S.out : { ...S.out, ...base }
          const runs = ansiSegments(text)
          if (runs === null) return h('pre', { style }, text)
          return h(
            'pre',
            { style },
            runs.map((run, index) => {
              const override = {}
              if (run.color !== undefined) override.color = run.color
              if (run.bold === true) override.fontWeight = 600
              if (run.dim === true) override.opacity = 0.7
              if (run.italic === true) override.fontStyle = 'italic'
              if (run.underline === true) override.textDecoration = 'underline'
              return Object.keys(override).length === 0 ? run.text : h('span', { key: index, style: override }, run.text)
            }),
          )
        }

        /** The row menu: reference, copy, open. */        const renderMenu = () => {
          const path = menu.path
          const item = (label, run) =>
            h(
              'button',
              {
                key: label,
                style: S.menuItem,
                onClick: (event) => {
                  event.stopPropagation()
                  setMenu(null)
                  run()
                },
              },
              label,
            )
          // Keep the panel inside the viewport when opened near an edge.
          const width = 168
          const height = 132
          const left = typeof window === 'undefined' ? menu.x : Math.min(menu.x, window.innerWidth - width - 8)
          const top = typeof window === 'undefined' ? menu.y : Math.min(menu.y, window.innerHeight - height - 8)
          return h(
            'div',
            { style: { ...S.menu, left: `${Math.max(8, left)}px`, top: `${Math.max(8, top)}px` }, onClick: (event) => event.stopPropagation() },
            item('引用到对话', () => insertReference(fileReference(path))),
            h('div', { key: 'sep1', style: S.menuSep }),
            item('复制路径', () => copyText(path, '路径')),
            item('复制内容', async () => {
              const text = await readForCopy(path)
              if (text === null) {
                setNotice('读取失败，没有内容可复制')
                return
              }
              await copyText(text, '内容')
            }),
            menu.path === openPath ? null : h('div', { key: 'sep2', style: S.menuSep }),
            menu.path === openPath ? null : item('打开', () => setOpenPath(path)),
          )
        }

        return h(
          'div',
          { style: S.root, ref: rootRef },
          h(
            'div',
            { style: S.bar },
            h(
              'button',
              {
                style: { ...S.iconBtn, background: treeOpen ? 'var(--dsw-alias-interactive-bg-active, rgba(91,140,255,.14))' : 'transparent' },
                title: treeOpen ? '隐藏文件树' : '显示文件树',
                onClick: () => setTreeOpen((value) => !value),
              },
              '☰',
            ),
            h(
              'span',
              {
                style: S.crumb,
                title: openPath || '',
                onContextMenu: openPath ? (event) => openMenu(event, openPath) : undefined,
              },
              openPath === null ? '工作区' : openPath,
            ),
            file && file.total !== undefined
              ? h('span', { style: { ...S.crumb, flex: '0 0 auto', opacity: 0.7 } }, `${file.total} 行`)
              : null,
            !editing && isMarkdown(openPath)
              ? h(
                  'button',
                  {
                    style: smallBtn({
                      color: mdRendered ? 'var(--dsw-alias-state-accent-primary, #9c83ff)' : 'var(--dsw-alias-label-secondary, #98a3b3)',
                      border: '1px solid rgba(140,110,255,.35)',
                    }),
                    title: mdRendered ? '显示 Markdown 源码' : '渲染 Markdown',
                    onClick: () => setMdRendered((value) => !value),
                  },
                  mdRendered ? '源码' : '预览',
                )
              : null,
            !editing && openPath !== null
              ? h(
                  'button',
                  {
                    style: smallBtn({
                      color: diffOpen ? 'var(--dsw-alias-state-accent-primary, #9c83ff)' : 'var(--dsw-alias-label-secondary, #98a3b3)',
                      border: '1px solid rgba(140,110,255,.35)',
                      opacity: hasAgentEdits ? 1 : 0.65,
                    }),
                    title: hasAgentEdits
                      ? '与上次查看的内容对比'
                      : '与上次查看的内容相同（点开可确认）',
                    onClick: () => setDiffOpen((value) => !value),
                  },
                  hasAgentEdits ? '差异 •' : '差异',
                )
              : null,
            !editing && hasAgentEdits
              ? h(
                  'button',
                  {
                    style: smallBtn({ opacity: 0.8 }),
                    title: '忘了这次对比；文件下次变化时会重新出现',
                    onClick: () => {
                      if (openPath) clearVersion(sid, openPath)
                      setFile((prev) => (prev ? { ...prev, baseText: prev.text } : prev))
                      setDiffOpen(false)
                    },
                  },
                  '清除对比',
                )
              : null,
            notice ? h('span', { style: { ...S.crumb, flex: '0 0 auto', color: 'var(--dsw-alias-state-success-primary, #3ddc97)' } }, notice) : null,
            editing
              ? h('button', { style: smallBtn({ color: 'var(--dsw-alias-state-success-primary, #3ddc97)' }), title: '保存 (Ctrl+S)', onClick: saveDraft }, '保存')
              : h(
                  'button',
                  {
                    style: smallBtn({ opacity: openPath === null ? 0.4 : 1 }),
                    title: openPath === null ? '先选一个文件' : '编辑',
                    onClick: () => {
                      if (openPath === null) return
                      setConflict(null)
                      setSelectionRef(null)
                      setEditPick(null)
                      setDraft(file && typeof file.text === 'string' ? file.text : '')
                    },
                  },
                  '编辑',
                ),
            editing
              ? h('button', { style: smallBtn({}), title: '放弃改动', onClick: () => { setDraft(null); setConflict(null); setSelectionRef(null) } }, '取消')
              : h(
                  'button',
                  {
                    style: smallBtn({ opacity: openPath === null || running ? 0.4 : 1 }),
                    title: canWrite ? '运行这个文件' : '缺少绝对工作目录',
                    onClick: runFile,
                  },
                  // The label doubles as a build marker: an older bundle showed a
                  // bare ellipsis here, which is indistinguishable from a hang.
                  running ? '● 运行中' : '▶ 运行',
                ),
            h(
              'button',
              {
                style: S.iconBtn,
                title: '刷新',
                onClick: () => {
                  if (openPath === null) loadLevel(root)
                  else loadFile(openPath)
                },
              },
              '⟳',
            ),
            // A word here costs the width the breadcrumb needs, and it was the
            // first thing to get clipped in a narrow pane.
            h(
              'span',
              {
                style: { flex: '0 0 auto', fontSize: '9px', opacity: 0.7, padding: '0 2px' },
                title: canWrite ? '可写：有绝对工作目录' : '只读：会话没有绝对工作目录',
              },
              canWrite ? '●' : '○',
            ),
          ),
          h(
            'div',
            { style: S.body },
            treeOpen && !editing ? h('div', { style: S.tree }, renderLevel(root, 0)) : null,
            editing
              ? h(
                  'div',
                  { style: S.editorShell, 'data-dsh-ide-editor': '' },
                  h(
                    'div',
                    { style: S.editorRow },
                    h(
                      'div',
                      { style: S.editorGutter, ref: gutterRef },
                      String(draft)
                        .split('\n')
                        .map((_, index) => h('div', { key: index, style: S.editorGutterLine }, String(index + 1))),
                    ),
                    h(
                      'div',
                      { style: S.editorPane },
                      plainEditor ? null : h('pre', { style: S.editorOverlay, ref: overlayRef, 'aria-hidden': 'true' }, highlightLayer),
                      h('textarea', {
                        style: plainEditor ? { ...S.editorArea, color: 'var(--dsw-alias-label-primary, #e7ecf3)' } : S.editorArea,
                        ref: editorRef,
                        value: draft,
                        spellCheck: false,
                        wrap: 'off',
                        onChange: (event) => {
                          const target = event.currentTarget || event.target
                          setDraft(target.value)
                          setSelectionRef(null)
                          updateCaret(target.value, target.selectionStart)
                        },
                        onScroll: syncEditorScroll,
                        onSelect: (event) => {
                          const target = event.currentTarget || event.target
                          const range = selectedLines(target.value, target.selectionStart, target.selectionEnd)
                          setSelectionRef(range && openPath ? { ...range, text: lineReference(openPath, range.start, range.end) } : null)
                          updateCaret(target.value, target.selectionStart)
                        },
                        onKeyDown: (event) => {
                          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                            event.preventDefault()
                            saveDraft()
                            return
                          }
                          if (event.key === 'Tab') {
                            event.preventDefault()
                            insertIndent()
                          }
                        },
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { style: S.statusBar },
                    h('span', null, `行 ${caret.line}，列 ${caret.col}`),
                    h('span', null, `${String(draft).split('\n').length} 行`),
                    h('span', null, `${String(draft).length} 字符`),
                    h('span', { style: { marginLeft: 'auto', color: file && draft === file.text ? 'var(--dsw-alias-label-tertiary, #7a8494)' : 'var(--dsw-alias-state-warning-primary, #e8b339)' } }, file && draft === file.text ? '未修改' : '已修改'),
                  ),
                )
              : h(
                  'div',
                  { style: S.column },
                  fileEdits.length > 0 ? renderEditStrip() : null,
                  h('div', { style: S.code }, renderMain()),
                ),
          ),
          conflict
            ? h(
                'div',
                { style: { ...S.refBar, borderTopColor: 'rgba(255,107,107,.35)', background: 'rgba(192,0,0,.08)' } },
                h('span', { style: { color: 'var(--dsw-alias-label-error, #ff6b6b)' } }, '保存冲突'),
                h('span', { style: { ...S.crumb, color: 'var(--dsw-alias-label-secondary, #98a3b3)' } }, '磁盘版本已变化，未覆盖'),
                h('button', {
                  style: smallBtn({}),
                  title: '对比草稿和磁盘内容',
                  onClick: () => setConflictDiff((value) => !value),
                }, conflictDiff ? '收起差异' : '看差异'),
                h('button', {
                  style: smallBtn({ marginLeft: 'auto' }),
                  onClick: () => {
                    contentVersionRef.current = conflict.diskVersion
                    setDraft(conflict.diskText)
                    setConflict(null)
                    setConflictDiff(false)
                    setSelectionRef(null)
                    setNotice('已载入磁盘版本')
                  },
                }, '载入新版本'),
                h('button', {
                  style: smallBtn({ color: 'var(--dsw-alias-label-error, #ff6b6b)' }),
                  title: '下一次保存将显式覆盖当前磁盘版本',
                  onClick: () => {
                    contentVersionRef.current = conflict.diskVersion
                    setConflict(null)
                    setNotice('已确认覆盖，再点保存')
                  },
                }, '保留草稿'),
              )
            : selectionRef
              ? h(
                  'div',
                  { style: S.refBar },
                  h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #7a8494)' } }, '选区'),
                  h('span', { style: S.refChip, title: selectionRef.text }, selectionRef.text),
                  h('button', { style: smallBtn({ marginLeft: 'auto', color: 'var(--dsw-alias-state-accent-primary, #9c83ff)' }), onClick: insertSelectionReference }, '引用到对话'),
                  h('button', { style: S.iconBtn, title: '清除选区引用', onClick: () => setSelectionRef(null) }, '×'),
                )
              : null,
          conflict && conflictDiff && draft !== null
            ? h(
                'div',
                { style: { ...S.drawer, maxHeight: '32%' } },
                h(
                  'div',
                  { style: S.drawerHead },
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary, #98a3b3)' } }, '草稿 vs 磁盘'),
                  h('span', { style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary, #7a8494)' } }, '− 草稿　+ 磁盘'),
                  h('button', { style: S.iconBtn, title: '关闭差异', onClick: () => setConflictDiff(false) }, '×'),
                ),
                renderDiff(draft, conflict.diskText),
              )
            : null,
          run
            ? h(
                'div',
                { style: S.drawer },
                h(
                  'div',
                  { style: S.drawerHead },
                  h('span', { style: S.prompt }, '❯'),
                  h('span', { style: S.cmd, title: run.command || '' }, run.command || '运行'),
                  (() => {
                    if (run.state === 'starting') {
                      return h('span', { style: { ...S.pill, background: 'rgba(127,127,127,.16)', color: 'var(--dsw-alias-label-secondary, #98a3b3)' } }, '启动中')
                    }
                    if (run.state === 'running') {
                      return h('span', { style: { ...S.pill, background: 'rgba(232,179,57,.16)', color: 'var(--dsw-alias-state-warning-primary, #e8b339)' } }, '运行中')
                    }
                    if (run.state === 'failed') return h('span', { style: { ...S.pill, ...S.pillBad } }, '失败')
                    const code = run.exitCode
                    return h('span', { style: { ...S.pill, ...(code === 0 ? S.pillOk : S.pillBad) } }, code === null || code === undefined ? '已停止' : String(code))
                  })(),
                  run.ms > 0 ? h('span', { style: S.dur }, `${run.ms}ms`) : null,
                  running
                    ? h('button', { style: smallBtn({ marginLeft: 'auto', color: 'var(--dsw-alias-label-error, #ff6b6b)' }), title: '结束这个进程', onClick: stopRun }, '■ 停止')
                    : h(
                        'button',
                        {
                          style: smallBtn({ marginLeft: 'auto', opacity: 0.85 }),
                          title: '复制输出',
                          onClick: () => copyText(applyCarriageReturns(sanitizeTerminal(run.text || '')), '输出'),
                        },
                        '复制',
                      ),
                  h('button', { style: S.iconBtn, title: '关闭输出', onClick: () => setRun(null) }, '×'),
                ),
                run.text
                  ? renderOutput(run.text, 'out')
                  : h('div', { style: { ...S.out, opacity: 0.6 } }, run.state === 'starting' ? '正在启动…' : '（没有输出）'),
              )
            : null,
          menu === null ? null : renderMenu(),
        )
      }
    }

    /** Build the tab chip title. */
    function makeTitle() {
      return function CodeTitle() {
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } }, '代码')
      }
    }

    /**
     * Inject the dominant-layout stylesheet once per page.
     * @returns a disposer that removes the element and the attribute.
     */
    function installDominantStyles() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.setAttribute('data-dsh-ide-dominant', '')
      style.textContent = DOMINANT_CSS + TREE_CSS + EDITOR_CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
        document.documentElement.removeAttribute(DOMINANT_ATTR)
      }
    }

    /**
     * Client plugin body.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(installDominantStyles, 'dsh-ide-pane: dominant layout')
      const getRemote = () => ctx.remote

      // One line naming the build, so a report of "it does nothing" can be
      // answered without guessing which bundle the page is running.
      try {
        console.info('[dsh-ide-pane] client', CLIENT_VERSION, { run: 'sse' })
      } catch {
        /* a diagnostic must never break the mount */
      }

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: KIND,
            // Claiming `dsh-resource://file/…` is what makes a file reference in
            // the chat open here instead of the plain text preview: candidate
            // types are ranked across kinds by priority band first, and this
            // plugin registers in the `extension` band while the shipped
            // preview registers as `fallback`.
            patterns: CLAIM_FILE_TABS ? [FILE_ADDRESS_GLOB] : [],
            canOpen: CLAIM_FILE_TABS ? openableFileAddress : undefined,
            title: titleForAddress,
            guide: [
              {
                id: 'code',
                order: 60,
                title: () => '代码',
                description: () => '浏览会话工作区的文件，Agent 改动后自动刷新',
              },
            ],
          }),
        'dsh-ide-pane: type',
      )

      const Body = makeBody(getRemote, ctx.layout)
      const Title = makeTitle()

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TYPE_ID,
                inject: () => ({ sessions: ctx.sessions.list }),
              },
              Body,
            ),
          ),
        'dsh-ide-pane: body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, Title),
          ),
        'dsh-ide-pane: title',
      )

      ctx.inject(['shortcuts'], (inner) => {
        // A shortcut is a convenience: if registration is rejected (a conflicting
        // binding, a host without the service) the pane must still open from the
        // guide card.
        try {
          inner.effect(
            () =>
              inner.shortcuts.register({
              id: 'ide.code',
              label: () => '代码面板',
              aliases: ['code', 'ide'],
              defaults: {
                'desktop:windows': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'desktop:macos': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'desktop:linux': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'web:windows': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'web:macos': { code: 'KeyI', modifiers: ['primary', 'alt'] },
              },
              regions: ['page', 'editable', 'terminal'],
              modals: [],
              resolve: ({ target }) => {
                const captured = inner.sidebarRight.commandTarget(target)
                if (captured === undefined) return { status: 'blocked', reason: '当前没有会话' }
                return {
                  status: 'handled',
                  run: () => {
                    inner.sidebarRight.openTabFromTarget(KIND, captured)
                  },
                }
              },
            }),
            'dsh-ide-pane: shortcut',
          )
        } catch (error) {
          console.warn('[dsh-ide-pane] shortcut unavailable', error)
        }
      })
    }

    return {
      name: 'dsh-ide-pane',
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'remote', 'remote.workspaceFiles', 'layout'],
      apply,
      /**
       * Pure helpers, exposed so the test harness can assert them directly.
       * The browser runtime never reads this field.
       */
      __test: {
        diffLines,
        selectedLines,
        lineReference,
        readBaseline: (sessionId, path) => {
          const record = readVersion(sessionId, path)
          return record === null ? null : record.text
        },
        writeBaseline: (sessionId, path, text) => writeVersion(sessionId, path, { text, prev: null }),
        readVersion,
        writeVersion,
        observeVersion,
        clearVersion,
        tokenize,
        langOf,
        TOKEN_COLOR,
        parseFileAddress,
        openableFileAddress,
        titleForAddress,
        ansiSegments,
        ANSI_COLOR,
        sanitizeTerminal,
        applyCarriageReturns,
        planRunCommand,
        renderMarkdown,
        mathNodes,
        inlineNodes,
        isMarkdown,
      },
    }
  },
})
