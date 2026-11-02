/*! BusinessMCP in-house heatmaps + session replay recorder.
    Lazy-loaded by track.js only when workspaces.settings.heatmaps.mode === 'inhouse'
    and the session passes sampling. Reads window.__mcphHM = {tracker, apiBase, vid,
    sid, cfg} handed off by track.js. Captures:
      - click / rage-click / dead-click coords + a stable selector + element-relative
        offset (survives responsive reflow), batched to /api/heatmap/event
      - scroll reach (deepest point per pageview), sent on pagehide
      - one rrweb DOM snapshot per (path,device) for the heatmap backdrop (the server keeps
        it on Growth and above; Free and Starter are refused at ingest)
      - continuous rrweb session replay chunks (Growth+ and cfg.replay_enabled) to
        /api/replay/ingest, with inputs masked before serialization.
    Analytics must never break the host page — everything is guarded. */
(function () {
  var W = window.__mcphHM
  if (!W || W.__started) return
  W.__started = true
  var tracker = W.tracker,
    apiBase = W.apiBase,
    vid = W.vid || '',
    sid = W.sid || vid || 'anon',
    cfg = W.cfg || {},
    // Client automation signals (webdriver/headless) from track.js; forwarded so the
    // server can reject bots that spoof a clean user-agent (mirrors the analytics beacon).
    botsig = W.botsig || null
  var hmEndpoint = apiBase + '/api/heatmap/event'
  var replayEndpoint = apiBase + '/api/replay/ingest'
  var replayOn = cfg.replay_enabled === true

  // ---- Per-event capture gate (2026-09-03) ----
  // track.js used to consult its internal-path list ONCE when deciding whether to load
  // hm.js, so a session that started on a public page and soft-navigated into the app
  // kept recording dashboard clicks, scrolls and replay as visitor behaviour (the
  // heatmap "top pages" were /dashboard and /login). Every capture now re-checks the
  // CURRENT path against (a) the tracker's data-internal-paths — W.isInternal is the
  // one implementation, handed over by track.js — and (b) the workspace's heatmap
  // exclude_paths (settings.heatmaps.exclude_paths, served in cfg).
  var isInternalPath = typeof W.isInternal === 'function' ? W.isInternal : function () { return false }
  var excludePaths = Array.isArray(cfg.exclude_paths) ? cfg.exclude_paths : []
  function pathExcluded(path, prefixes) {
    for (var i = 0; i < prefixes.length; i++) {
      var pre = String(prefixes[i] || '')
      if (!pre) continue
      // "/" can only mean the homepage itself (lib/analytics/app-paths.ts:isAppPath): as
      // a prefix it matched EVERY path, so excluding the homepage silently switched
      // heatmaps and replay off across the whole site while the server excluded only "/".
      if (pre === '/') {
        if (path === '/') return true
        continue
      }
      if (path === pre || path.indexOf(pre.charAt(pre.length - 1) === '/' ? pre : pre + '/') === 0) return true
    }
    return false
  }
  // Set by W.stop() (consent withdrawn): every capture path goes through shouldCapture.
  var stopped = false
  function shouldCapture(path) {
    if (stopped) return false
    try {
      return !isInternalPath(path) && !pathExcluded(path, excludePaths)
    } catch (e) {
      return true
    }
  }

  // ---- Frustration definitions ----
  // Byte-equivalent twins of lib/heatmaps/frustration-logic.ts; the parity test
  // (lib/heatmaps/frustration-parity.test.ts) extracts these three and diffs them, so
  // they must stay self-contained (parameters + Math only, constants inlined).
  var RAGE_WINDOW_MS = 700, RAGE_MIN = 3, DEAD_MS = 1000
  function isInteractiveLike(tag, role, hasHref, hasOnclick, cursor, hasGoalAttr) {
    var t = String(tag || '').toLowerCase()
    var r = String(role || '').toLowerCase()
    if (' a button input select textarea label summary img svg video audio '.indexOf(' ' + t + ' ') !== -1) return true
    if (r && ' button link tab menuitem checkbox radio switch option '.indexOf(' ' + r + ' ') !== -1) return true
    if (hasHref || hasOnclick || hasGoalAttr) return true
    return String(cursor || '').toLowerCase() === 'pointer'
  }
  function shouldCountDead(i) {
    if (!i.interactive) return false
    if (i.focused) return false
    if (Number(i.detail) > 1) return false
    if (i.mutated || i.navigated) return false
    return Number(i.selectionLength) === 0
  }
  function shouldCountRage(i) {
    if (i.editable) return false
    if (Number(i.selectionLength) > 0) return false
    if (Number(i.burst) < 3) return false
    return Math.abs(Number(i.dx)) < 30 && Math.abs(Number(i.dy)) < 30
  }

  function device() {
    var w = window.innerWidth || document.documentElement.clientWidth || 0
    return w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop'
  }
  function docHeight() {
    var b = document.body,
      e = document.documentElement
    return Math.max(b ? b.scrollHeight : 0, b ? b.offsetHeight : 0, e ? e.clientHeight : 0, e ? e.scrollHeight : 0, e ? e.offsetHeight : 0)
  }
  // NB: fetch({keepalive:true}) caps the request body at 64KB (Fetch spec). rrweb
  // FullSnapshots + the replay chunk that carries them run well over that, so
  // keepalive is used ONLY for the small final unload drain — mid-session posts
  // (snapshots, replay/click flushes) go through a plain fetch with no size cap.
  // text/plain, NEVER application/json (the same rule as track.js's beacon): sendBeacon
  // always sends credentials, a non-safelisted Content-Type forces a CORS preflight that
  // our `Access-Control-Allow-Origin: *` cannot satisfy for a credentialed request, and
  // sendBeacon still returns true — so on every customer site (cross-origin to our API)
  // the replay tail, the last click batch and EVERY scroll-reach row were dropped
  // silently. Both ingest routes read req.text() + JSON.parse, so the type is cosmetic.
  // Size is measured in BYTES: s.length counts UTF-16 units, and CJK/emoji text is up to
  // 3x larger on the wire than it looks.
  function post(url, body, beacon) {
    try {
      var s = JSON.stringify(body)
      var bytes = s.length
      try {
        bytes = new Blob([s]).size
      } catch (e) {}
      if (beacon) {
        if (navigator.sendBeacon && bytes < 60000) {
          if (navigator.sendBeacon(url, new Blob([s], { type: 'text/plain' }))) return
        }
        // Unload path: keepalive only if it fits the 64KB budget, else best-effort.
        fetch(url, { method: 'POST', body: s, keepalive: bytes < 60000, headers: { 'Content-Type': 'text/plain' } }).catch(function () {})
        return
      }
      fetch(url, { method: 'POST', body: s, headers: { 'Content-Type': 'text/plain' } }).catch(function () {})
    } catch (e) {}
  }

  // ---- Stable selector (finder-lite): id → stable data-*/aria attr → word-like
  // classes → :nth-of-type, walking up until the path is unique. Rejects hashed
  // classes (css-1a2b3c / sc-* / jsx-* / emotion) so it survives CSS-in-JS churn. ----
  var STABLE_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id', 'name', 'aria-label', 'role']
  function esc(s) {
    try {
      return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
    } catch (e) {
      return s
    }
  }
  function wordLike(s) {
    if (!s || s.length < 3 || s.length > 40) return false
    if (!/^[a-zA-Z][\w-]*$/.test(s)) return false
    if (/(^css-|^sc-|^jsx-|^emotion-|^chakra-|^_)/i.test(s)) return false
    if (/[0-9a-f]{6,}/i.test(s)) return false // hashed hex-ish suffixes
    if (/^[a-z0-9]{7,}$/i.test(s) && /\d/.test(s)) return false // random-looking token
    return true
  }
  function nthOfType(node) {
    var i = 1,
      sib = node
    while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) i++
    return i
  }
  function uniq(sel) {
    try {
      return document.querySelectorAll(sel).length === 1
    } catch (e) {
      return false
    }
  }
  function stableSelector(el) {
    if (!el || el.nodeType !== 1) return null
    try {
      if (el.id && wordLike(el.id) && uniq('#' + esc(el.id))) return '#' + esc(el.id)
      var parts = [],
        node = el,
        depth = 0
      while (node && node.nodeType === 1 && node.tagName !== 'HTML' && depth < 6) {
        if (node.id && wordLike(node.id)) {
          parts.unshift('#' + esc(node.id))
          if (uniq(parts.join('>'))) return parts.join('>')
          break
        }
        var seg = node.tagName.toLowerCase(),
          attr = null
        for (var i = 0; i < STABLE_ATTRS.length; i++) {
          var a = node.getAttribute && node.getAttribute(STABLE_ATTRS[i])
          if (a && a.length < 80 && wordLike(a.replace(/\s+/g, '-'))) {
            attr = '[' + STABLE_ATTRS[i] + '="' + a + '"]'
            break
          }
        }
        if (attr) seg += attr
        else {
          var cls = node.className && typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(wordLike).slice(0, 2) : []
          if (cls.length) seg += '.' + cls.map(esc).join('.')
          else {
            var n = nthOfType(node)
            if (n > 1) seg += ':nth-of-type(' + n + ')'
          }
        }
        parts.unshift(seg)
        if (uniq(parts.join('>'))) return parts.join('>')
        node = node.parentElement
        depth++
      }
      // Still ambiguous after 6 levels. Never ship a selector that matches more than one
      // element: the viewer resolves it in the backdrop and would pin every click on the
      // FIRST match (a class combo shared by the header button and the submit button
      // put submit clicks on the header). Fall back to a structural path.
      var full = parts.join('>')
      if (full && uniq(full)) return full
      return structuralPath(el)
    } catch (e) {
      return null
    }
  }
  // tag:nth-of-type chain up to the nearest unique id (or <body>): unique by
  // construction, and re-checked so a DOM that moved under us returns null instead.
  function structuralPath(el) {
    try {
      var parts = [],
        node = el
      while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
        if (node !== el && node.id && wordLike(node.id) && uniq('#' + esc(node.id))) {
          parts.unshift('#' + esc(node.id))
          break
        }
        var tag = node.tagName.toLowerCase()
        if (tag === 'body') {
          parts.unshift('body')
          break
        }
        parts.unshift(tag + ':nth-of-type(' + nthOfType(node) + ')')
        node = node.parentElement
      }
      var sel = parts.join('>')
      return sel && uniq(sel) ? sel : null
    } catch (e) {
      return null
    }
  }

  // ---- Click / scroll capture, batched ----
  var clicks = [],
    scrolls = [],
    FLUSH_MS = 5000,
    MAX_BATCH = 60,
    SETTLE_MS = 1200
  // X is stored as a fraction of the layout width in a fixed reference resolution
  // (NX_REF units, snapped to a 16px-equiv grid at ingest) rather than absolute pixels,
  // so a click on the same element aligns onto the one recorded backdrop regardless of
  // the visitor's monitor width. The dashboard de-normalizes: px = x/NX_REF * backdropW.
  // Y stays absolute page pixels (already viewport-height-independent). Keep NX_REF in
  // sync with components/dashboard/heatmap-viewer.tsx.
  var NX_REF = 8192
  function flush(beacon) {
    if (!clicks.length && !scrolls.length) return
    var body = { trackerId: tracker, visitorId: vid, url: location.href, device: device(), clicks: clicks.slice(0, MAX_BATCH), scrolls: scrolls.slice(0, MAX_BATCH), bot_signals: botsig }
    clicks = []
    scrolls = []
    post(hmEndpoint, body, beacon)
  }
  setInterval(function () {
    flush(false)
  }, FLUSH_MS)

  // Nearest fixed/sticky container (the target itself or an ancestor): a click on the
  // <svg> inside a fixed chat launcher is a click on a fixed element, and its page Y is
  // its viewport Y, not viewport Y + scroll.
  function inFixed(el) {
    try {
      var node = el
      while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
        var p = getComputedStyle(node).position
        if (p === 'fixed' || p === 'sticky') return true
        node = node.parentElement
      }
    } catch (e) {}
    return false
  }
  // Build the click row at CLICK time. Everything (scroll, rect, device) is read now:
  // the dead-click verdict lands 1s later, and reading scroll/rect then mis-placed it
  // whenever the page moved in between.
  function buildClick(ev, type) {
    try {
      if (!shouldCapture(location.pathname)) return null
      var el = ev.target
      if (!el || el.nodeType !== 1) return null
      var fixed = inFixed(el)
      var sx = window.scrollX || document.documentElement.scrollLeft || 0
      var sy = window.scrollY || document.documentElement.scrollTop || 0
      var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null
      var cx = ev.clientX,
        cy = ev.clientY,
        kb = 0
      // Keyboard / implicit-submit activation (Enter in a form, Space on a button)
      // dispatches a click with detail 0 at clientX/Y 0. Recording (0,0) drew those
      // clicks in the page's top-left corner; anchor them on the element's centre.
      if (Number(ev.detail) === 0 && !cx && !cy && rect && (rect.width || rect.height)) {
        cx = rect.left + rect.width / 2
        cy = rect.top + rect.height / 2
        kb = 1
      }
      // X is a fraction of the layout width (NX_REF units). It is the FALLBACK
      // coordinate only: on a centred max-width layout the same element sits at a
      // different fraction on every screen width, so the viewer places clicks by
      // selector + (rx, ry) and uses x only for visitors at the backdrop's width.
      var pageX = cx + (fixed ? 0 : sx)
      var baseW = fixed
        ? window.innerWidth || document.documentElement.clientWidth || 0
        : document.documentElement.clientWidth || document.documentElement.scrollWidth || 0
      var fracX = baseW > 0 ? pageX / baseW : 0
      var x = Math.round(Math.max(0, Math.min(1, fracX)) * NX_REF)
      var y = Math.round(cy + (fixed ? 0 : sy))
      var rx = rect && rect.width ? (cx - rect.left) / rect.width : 0.5
      var ry = rect && rect.height ? (cy - rect.top) / rect.height : 0.5
      return {
        hm_type: type,
        x: x,
        y: y,
        tf: fixed ? 1 : 0,
        kb: kb,
        dv: device(),
        vw: window.innerWidth || 0,
        vh: window.innerHeight || 0,
        pw: document.documentElement.scrollWidth || 0,
        ph: docHeight(),
        sel: stableSelector(el),
        rx: Math.max(0, Math.min(1, rx)),
        ry: Math.max(0, Math.min(1, ry)),
        path: location.pathname,
      }
    } catch (e) {
      return null
    }
  }
  function pushClick(row, type) {
    if (!row) return
    var r = {}
    for (var k in row) r[k] = row[k]
    r.hm_type = type
    clicks.push(r)
    if (clicks.length >= MAX_BATCH) flush(false)
  }

  // DOM-side helpers for the frustration predicates above.
  function selLen() {
    try {
      return String(window.getSelection ? window.getSelection() : '').length
    } catch (e) {
      return 0
    }
  }
  // Does this element (or a near ancestor) look like something a visitor expects to
  // respond? Walks up to 3 levels so a click on the <span> inside a styled card-link
  // still counts as a click on the card.
  function looksInteractive(el) {
    try {
      var node = el,
        depth = 0
      while (node && node.nodeType === 1 && depth < 4) {
        var cur = ''
        try {
          cur = getComputedStyle(node).cursor || ''
        } catch (e) {}
        if (
          isInteractiveLike(
            node.tagName,
            node.getAttribute('role') || '',
            !!(node.href || node.hasAttribute('href')),
            node.hasAttribute('onclick') || typeof node.onclick === 'function',
            cur,
            node.hasAttribute('data-mcph-goal') || node.hasAttribute('data-goal'),
          )
        )
          return true
        if (node.isContentEditable) return true
        node = node.parentElement
        depth++
      }
    } catch (e) {}
    return false
  }
  // Did the click land on (or move focus into) a form control? Focusing a field is the
  // field's response — it mutates no DOM — so it must never count as a dead click.
  function focusedField(el) {
    try {
      if (isEditable(el)) return true
      var lab = el.closest ? el.closest('label') : null
      if (lab && (lab.control || lab.querySelector('input,select,textarea'))) return true
      var a = document.activeElement
      return !!(a && a !== document.body && isEditable(a) && (a === el || (el.contains && el.contains(a)) || (a.contains && a.contains(el))))
    } catch (e) {
      return false
    }
  }
  function isEditable(el) {
    try {
      var t = (el.tagName || '').toLowerCase()
      return t === 'input' || t === 'textarea' || t === 'select' || !!el.isContentEditable
    } catch (e) {
      return false
    }
  }

  // Rage: 3+ clicks within ~700ms in a ~30px box, never on a text-editing target and
  // never while text is selected (a triple-click select-all is the classic false
  // positive). Dead: a single click on something that LOOKS interactive that produced
  // no DOM mutation, no navigation and no selection within 1s — a click on paragraph
  // text or whitespace is not a dead click.
  var recent = []
  var mutatedAt = 0
  try {
    new MutationObserver(function () {
      mutatedAt = Date.now()
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
  } catch (e) {}
  document.addEventListener(
    'click',
    function (ev) {
      try {
        var now = Date.now()
        var el = ev.target
        var row = buildClick(ev, 'click')
        pushClick(row, 'click')
        recent.push({ t: now, x: ev.clientX, y: ev.clientY })
        recent = recent.filter(function (c) {
          return now - c.t < RAGE_WINDOW_MS
        })
        if (recent.length >= RAGE_MIN) {
          var a = recent[0],
            b = recent[recent.length - 1]
          if (shouldCountRage({ editable: isEditable(el), selectionLength: selLen(), burst: recent.length, dx: a.x - b.x, dy: a.y - b.y })) {
            recent = []
            pushClick(row, 'rageclick')
          }
        }
        var before = mutatedAt,
          href0 = location.href,
          interactive = looksInteractive(el),
          detail = ev.detail
        setTimeout(function () {
          try {
            if (shouldCountDead({ interactive: interactive, detail: detail, mutated: mutatedAt !== before, navigated: location.href !== href0, selectionLength: selLen(), focused: focusedField(el) })) pushClick(row, 'deadclick')
          } catch (e) {}
        }, DEAD_MS)
      } catch (e) {}
    },
    true,
  )

  // Scroll reach: rAF-throttled running max per pageview, committed ONCE per pageview —
  // at the first of tab-hide / pagehide / route change. Committing on every tab switch
  // (and again on the pagehide that follows the hide) wrote 2-3 rows per pageview
  // (1,776 rows for 565 sessions), inflating the reach curve's denominator.
  var maxDepth = 0,
    ticking = false,
    scrollCommitted = false,
    curPath = location.pathname
  function measure() {
    try {
      var sy = window.scrollY || document.documentElement.scrollTop || 0
      var vh = window.innerHeight || document.documentElement.clientHeight || 0
      var dh = docHeight()
      if (dh > 0) maxDepth = Math.max(maxDepth, Math.min(100, Math.round(((sy + vh) / dh) * 100)))
    } catch (e) {}
  }
  window.addEventListener(
    'scroll',
    function () {
      if (ticking) return
      ticking = true
      requestAnimationFrame(function () {
        ticking = false
        measure()
      })
    },
    { passive: true },
  )
  // `leaving` = a route change: the DOM on screen is already the NEXT page's, so measuring
  // now would file its depth under the page being left. Use what was measured on it.
  function commitScroll(leaving) {
    if (scrollCommitted) return
    if (!leaving) measure()
    // curPath is the page being committed (the one we just left on a soft nav).
    if (maxDepth > 0 && shouldCapture(curPath)) {
      scrolls.push({ max_depth_pct: maxDepth, vh: window.innerHeight || 0, doc_h: docHeight(), path: curPath, dv: device() })
      scrollCommitted = true
    }
  }
  // Detect SPA path changes to commit the prior page's scroll depth + re-capture a
  // backdrop snapshot for the newly navigated page (rrweb only emits a FullSnapshot at
  // record start, so a soft nav would otherwise leave the new path with no backdrop).
  // Replay follows the same gate with pause-and-rebase semantics: while the visitor is
  // on an internal/excluded path every rrweb event is dropped (a server-side drop of a
  // chunk would desync the incremental stream — the hazard the idle gate documents
  // below), and on return to a public path a fresh FullSnapshot re-bases the stream.
  // replayPath is what a flushed chunk is stamped with — the last PUBLIC path, so a
  // chunk flushed just after a nav into /dashboard still carries the page it recorded.
  var replayPath = location.pathname,
    replayPaused = false
  // Route changes are caught AT the history call (pushState/replaceState/popstate/
  // hashchange), not by the old 1s poll: up to a second of the previous page's events
  // used to go out stamped with the NEW path (wrong page_count / entry_path) and its
  // scroll depth was measured on the new page. The poll stays as a fallback.
  function onNav() {
    if (location.pathname === curPath) return
    commitScroll(true)
    var wasPublic = shouldCapture(curPath)
    // Ship the page being left under ITS path before re-stamping.
    if (replayOn && wasPublic) flushReplay(false)
    curPath = location.pathname
    maxDepth = 0
    scrollCommitted = false
    if (shouldCapture(curPath)) {
      replayPath = curPath
      // Wait for the new page's DOM to settle before snapshotting. A paused replay (back
      // from an internal page) stays paused until that FullSnapshot re-bases it.
      setTimeout(captureSnapshotForCurrentPath, SETTLE_MS)
    }
  }
  try {
    ;['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m]
      history[m] = function () {
        var r = orig.apply(this, arguments)
        try {
          onNav()
        } catch (e) {}
        return r
      }
    })
    window.addEventListener('popstate', onNav)
    window.addEventListener('hashchange', onNav)
  } catch (e) {}
  setInterval(onNav, 1000)

  // ---- rrweb: DOM snapshot (backdrop) + replay chunks (both kept server-side on Growth+ only) ----
  var replayBuf = [],
    replayFlushed = false,
    replaySeq = 0,
    snapSentFor = {},
    lastMeta = null
  // Chunk seq must be monotonic across the WHOLE tab session (a hard navigation reloads
  // hm.js and would otherwise reset seq to 0, colliding with the prior page's chunk keys
  // — same session_hash + `onConflict: recording_id,seq` upsert → the new page overwrites
  // the old one, collapsing a multi-page recording to its last page). Persist it in
  // sessionStorage alongside mcph_rsid so full-page navs keep counting up.
  try {
    var savedSeq = parseInt(sessionStorage.getItem('mcph_rseq') || '', 10)
    if (savedSeq > 0) replaySeq = savedSeq
  } catch (e) {}

  // Inactivity gate: only keep replay events while the visitor is actually engaging, so an
  // open-but-idle tab (timers/animations churning the DOM) doesn't inflate a recording with
  // idle mutations. User interaction marks activity; after IDLE_MS with none, incremental
  // rrweb events are dropped. On resume we force a fresh FullSnapshot so the post-idle stream
  // re-bases cleanly — dropping deltas mid-stream without a re-base would desync the replay.
  var IDLE_MS = 180000 // 3 min of no interaction => treat further DOM churn as idle
  var lastActivityAt = Date.now()
  var idleNow = false
  function markActivity() {
    // Activity is stamped BEFORE the re-base snapshot: that snapshot is emitted
    // synchronously and the gate below would otherwise still read the tab as idle.
    lastActivityAt = Date.now()
    if (idleNow) {
      idleNow = false
      try {
        if (replayOn && rrwebRecord && rrwebRecord.takeFullSnapshot) rrwebRecord.takeFullSnapshot(true)
      } catch (e) {}
    }
  }
  function isIdle() {
    if (Date.now() - lastActivityAt > IDLE_MS) return true
    try {
      return document.visibilityState === 'hidden' // a hidden tab is nobody watching
    } catch (e) {
      return false
    }
  }
  ;['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (t) {
    try {
      window.addEventListener(t, markActivity, { passive: true, capture: true })
    } catch (e) {}
  })
  // Document scroll only: a capturing listener also heard every auto-scrolling carousel
  // and kept an unattended tab "active" forever.
  try {
    window.addEventListener('scroll', markActivity, { passive: true })
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') markActivity()
    })
  } catch (e) {}
  // ARM GATE: nothing is shipped (replay chunks or the heatmap backdrop) until the visitor
  // INTERACTS — pointer, key, wheel or touch-move. A render-and-leave client (a headless
  // crawler on a Singapore datacenter shipped 117 one-page, zero-click, no-scroll replays in
  // two weeks, none of which ever sent an analytics event) produces no recording at all.
  // Until then rrweb records into memory as usual, so a human's replay still starts at page
  // load. Once armed, the whole tab session stays armed (`mcph_rarmed`), so the next page of
  // a real visit ships from its first event. A bare document scroll does not arm: it can be
  // programmatic.
  var armed = false,
    pendingSnap = null,
    PRE_ARM_MAX = 500
  try {
    armed = sessionStorage.getItem('mcph_rarmed') === '1'
  } catch (e) {}
  function arm() {
    if (armed) return
    armed = true
    try {
      sessionStorage.setItem('mcph_rarmed', '1')
    } catch (e) {}
    try {
      if (pendingSnap && pendingSnap.path === location.pathname) sendSnapshot(pendingSnap.ev, pendingSnap.meta)
    } catch (e) {}
    pendingSnap = null
    if (replayOn) flushReplay(false)
  }
  ;['pointerdown', 'keydown', 'wheel', 'touchmove'].forEach(function (t) {
    try {
      window.addEventListener(t, arm, { passive: true, capture: true })
    } catch (e) {}
  })
  // The vendored @rrweb/record UMD bundle exposes the namespace as window.rrwebRecord
  // with a `.record` member (older builds set window.rrweb.record) — resolve either.
  function resolveRecord() {
    var g = window.rrwebRecord
    if (typeof g === 'function') return g
    if (g && typeof g.record === 'function') return g.record
    if (window.rrweb && typeof window.rrweb.record === 'function') return window.rrweb.record
    return null
  }
  function loadRrweb(cb) {
    var r = resolveRecord()
    if (r) return cb(r)
    var sc = document.createElement('script')
    sc.async = true
    sc.src = apiBase + '/vendor/rrweb-record.min.js'
    sc.onload = function () {
      cb(resolveRecord())
    }
    sc.onerror = function () {
      cb(null)
    }
    ;(document.head || document.documentElement).appendChild(sc)
  }
  function flushReplay(beacon) {
    if (!armed) return // held in memory until the first interaction (see the arm gate)
    if (!replayBuf.length) return
    var events = replayBuf
    replayBuf = []
    // Never reuse a seq: a page restored from the back/forward cache still holds the seq
    // it had when it was frozen, while the pages after it already wrote higher ones — and
    // ingest UPSERTS on (recording_id, seq), so a reused seq overwrote another page's chunk.
    try {
      var stored = parseInt(sessionStorage.getItem('mcph_rseq') || '', 10)
      if (stored > replaySeq) replaySeq = stored
    } catch (e) {}
    var seq = replaySeq++
    replayFlushed = true
    try {
      sessionStorage.setItem('mcph_rseq', String(replaySeq))
      sessionStorage.setItem('mcph_rlast', String(Date.now()))
    } catch (e) {}
    post(replayEndpoint, { trackerId: tracker, visitorId: vid, sid: sid, url: location.href, path: replayPath, device: device(), kind: 'replay', seq: seq, events: events, meta: { vw: window.innerWidth, vh: window.innerHeight }, bot_signals: botsig }, beacon)
  }
  // The backdrop must show the page as visitors CLICKED it, not as it was at first paint:
  // webfonts swap in, lazy images and late-mounted sections push everything down, and a
  // snapshot taken at rrweb start froze the shorter, unstyled layout. Snapshots are only
  // kept once the page has settled (load + fonts + a short idle).
  var pageSettled = false
  function whenSettled(cb) {
    var fired = false
    function go() {
      if (fired) return
      fired = true
      setTimeout(function () {
        pageSettled = true
        cb()
      }, SETTLE_MS)
    }
    function afterLoad() {
      try {
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(go, go)
          setTimeout(go, 3000)
          return
        }
      } catch (e) {}
      go()
    }
    if (document.readyState === 'complete') afterLoad()
    else window.addEventListener('load', afterLoad)
    // Never wait forever on a page whose load event is held open by a slow third party.
    setTimeout(go, 8000)
  }
  function sendSnapshot(fullEvent, metaEv) {
    if (!pageSettled) return
    if (!shouldCapture(location.pathname)) return
    // Not armed yet: keep the newest settled snapshot and send it on the first interaction.
    if (!armed) {
      pendingSnap = { ev: fullEvent, meta: lastMeta, path: location.pathname }
      return
    }
    var key = device() + '|' + location.pathname
    if (snapSentFor[key]) return
    snapSentFor[key] = 1
    // Ship the rrweb Meta event (type 4, viewport dims) with the FullSnapshot so the
    // dashboard Replayer can size the backdrop correctly.
    var events = [metaEv || lastMeta, fullEvent].filter(Boolean)
    // doc_w = the layout width (clientWidth) the click X was normalized against — keep in
    // sync with baseW in buildClick so the backdrop and click overlay share one X box.
    var docW = document.documentElement.clientWidth || document.documentElement.scrollWidth
    post(replayEndpoint, { trackerId: tracker, visitorId: vid, sid: sid, url: location.href, path: location.pathname, device: device(), kind: 'snapshot', events: events, meta: { doc_w: docW, doc_h: docHeight(), vh: window.innerHeight || 0 }, bot_signals: botsig }, false)
  }
  var rrwebRecord = null,
    oneShotStop = null
  function recorderOpts(emit) {
    return {
      emit: emit,
      maskAllInputs: cfg.mask_all_inputs !== false,
      maskTextClass: 'mcph-mask',
      blockClass: 'mcph-block',
      ignoreClass: 'mcph-ignore',
      recordCanvas: false,
      sampling: { mousemove: false, scroll: 150, media: 800 },
      checkoutEveryNms: 5 * 60 * 1000,
    }
  }
  // Non-replay plans: spin up a throwaway recorder just long enough to emit one
  // FullSnapshot for the current path, then stop it to save CPU.
  function startSnapshotRecorder() {
    if (!rrwebRecord || oneShotStop) return
    try {
      oneShotStop = rrwebRecord(
        recorderOpts(function (ev) {
          try {
            if (ev && ev.type === 4) lastMeta = ev // rrweb Meta (viewport dims)
            if (ev && ev.type === 2) {
              sendSnapshot(ev)
              if (oneShotStop) {
                try {
                  oneShotStop()
                } catch (e) {}
                oneShotStop = null
              }
            }
          } catch (e) {}
        }),
      )
    } catch (e) {}
  }
  // Re-capture a backdrop for the page the visitor just soft-navigated to. snapSentFor is
  // keyed device|path, so a new path is a fresh key and isn't deduped.
  function captureSnapshotForCurrentPath() {
    if (!rrwebRecord) return
    if (replayOn) {
      try {
        if (rrwebRecord.takeFullSnapshot) rrwebRecord.takeFullSnapshot(true)
      } catch (e) {}
    } else {
      startSnapshotRecorder()
    }
  }
  // Back/forward cache restore: no load event, no new FullSnapshot, and this frozen page
  // missed every chunk the later pages wrote. Re-base the stream so the player never
  // applies this page's incremental events on top of another page's DOM.
  window.addEventListener('pageshow', function (e) {
    if (!e || !e.persisted) return
    try {
      var stored = parseInt(sessionStorage.getItem('mcph_rseq') || '', 10)
      if (stored > replaySeq) replaySeq = stored
    } catch (err) {}
    if (replayOn && shouldCapture(location.pathname)) captureSnapshotForCurrentPath()
  })

  // "Duplicate tab" (and window.open without noopener) copies sessionStorage, so two live
  // tabs carried the same recording id and seq counter and overwrote each other's chunks,
  // interleaving two DOMs into one replay. Every tab answers for its id; a tab that hears
  // an answer for the id it just started with mints its own before its first flush (the
  // first replay flush is at least 5s away; this answers within one task).
  try {
    if (replayOn && typeof BroadcastChannel === 'function') {
      var rsidCh = new BroadcastChannel('mcph_rsid')
      var claimId = Math.random().toString(36).slice(2)
      rsidCh.onmessage = function (m) {
        var d = (m && m.data) || {}
        if (d.q === sid && d.from !== claimId) rsidCh.postMessage({ a: sid, from: claimId })
        else if (d.a === sid && d.from !== claimId && !replayFlushed) {
          sid = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
          replaySeq = 0
          try {
            sessionStorage.setItem('mcph_rsid', sid)
            sessionStorage.removeItem('mcph_rseq')
          } catch (err) {}
        }
      }
      rsidCh.postMessage({ q: sid, from: claimId })
    }
  } catch (e) {}

  // Consent withdrawn (track.js mcph.consent('denied')): stop recording NOW, not at the
  // next page load — drop what is buffered, stop both recorders, forget the recording id.
  var replayStop = null
  W.stop = function () {
    stopped = true
    clicks = []
    scrolls = []
    replayBuf = []
    try {
      if (typeof replayStop === 'function') replayStop()
    } catch (e) {}
    try {
      if (oneShotStop) oneShotStop()
    } catch (e) {}
    try {
      sessionStorage.removeItem('mcph_rsid')
      sessionStorage.removeItem('mcph_rseq')
      sessionStorage.removeItem('mcph_rlast')
    } catch (e) {}
  }

  loadRrweb(function (record) {
    if (typeof record !== 'function') return
    rrwebRecord = record
    if (replayOn) {
      // Pro replay: keep the recorder running continuously; every FullSnapshot (initial +
      // takeFullSnapshot on nav) doubles as a heatmap backdrop.
      replayStop = record(
        recorderOpts(function (ev) {
          try {
            // Internal / excluded path: drop everything (incl. Meta/FullSnapshot — a
            // 5-min checkout or idle-resume snapshot would otherwise ship the dashboard
            // DOM). The nav poller re-bases with a fresh FullSnapshot on return.
            if (!shouldCapture(location.pathname)) {
              replayPaused = true
              return
            }
            if (ev && ev.type === 4) lastMeta = ev
            if (ev && ev.type === 2) sendSnapshot(ev)
            // Back from an internal page: incremental events refer to node ids of a DOM
            // the recording never saw. Hold them until the re-base FullSnapshot lands.
            if (replayPaused) {
              if (!ev || (ev.type !== 2 && ev.type !== 4)) return
              if (ev.type === 2) replayPaused = false
            }
            // Idle (no interaction for IDLE_MS, or the tab is hidden): drop EVERYTHING,
            // rrweb's 5-minute checkout snapshots included — an unattended tab shipped a
            // full-DOM chunk every 5 minutes, each crediting up to 60s of "engaged" time.
            // markActivity's resume snapshot re-bases the stream.
            if (isIdle()) {
              idleNow = true
              return
            }
            // Pre-arm: bounded. Past the cap, start over from a fresh FullSnapshot (a stream
            // cut mid-way would desync), so the replay begins nearer the interaction.
            if (!armed && replayBuf.length >= PRE_ARM_MAX && ev && ev.type !== 2 && ev.type !== 4) {
              replayBuf = []
              // Outside rrweb's own emit call: a re-entrant snapshot from inside it is unsafe.
              setTimeout(function () {
                try {
                  if (rrwebRecord && rrwebRecord.takeFullSnapshot) rrwebRecord.takeFullSnapshot(true)
                } catch (e) {}
              }, 0)
              return
            }
            replayBuf.push(ev)
            if (replayBuf.length >= 50) flushReplay(false)
          } catch (e) {}
        }),
      )
      setInterval(function () {
        flushReplay(false)
      }, FLUSH_MS)
      // The recorder's opening FullSnapshot is replay-only (not settled yet); once the
      // page settles, take a fresh one, which doubles as the heatmap backdrop.
      whenSettled(function () {
        if (shouldCapture(location.pathname)) captureSnapshotForCurrentPath()
      })
    } else {
      whenSettled(startSnapshotRecorder)
    }
  })

  // Final drain on page hide (covers scroll depth, click batch, replay tail).
  // `final` = pagehide. A tab-hide commits scroll only on touch devices, where a
  // backgrounded tab is often killed with no pagehide; on desktop a hide is usually a tab
  // switch mid-read, and committing then would freeze the depth before the visitor came
  // back and kept scrolling (pagehide fires reliably on desktop).
  var coarse = false
  try {
    coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  } catch (e) {}
  function onHide(final) {
    try {
      if (final === true || coarse) commitScroll(false)
      flush(true)
      if (replayOn) flushReplay(true)
    } catch (e) {}
  }
  window.addEventListener('pagehide', function () {
    onHide(true)
  })
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') onHide(false)
  })
})()
