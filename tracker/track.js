/*! BusinessMCP Analytics — cookieless, one deferred script. Not minified or renamed,
    so you can read exactly what runs on your site (comments are stripped from the
    served copy to save bytes). Usage:
    <script defer src="https://businessmcp.com/track.js" data-tracker="trk_xxx"></script>
    Tip: serving this from your own subdomain (link.yourdomain.com → CNAME) makes
      it first-party so ad blockers don't drop it. The script posts back to whatever
      origin served it, so no snippet change is needed beyond the src.
    Pre-load calls: add `window.mcph={q:[]};` before the tag and push
      `mcph.q.push(['track',['signup']])` — they replay once the script loads, and
      `mcph.q.push` keeps working after load (it runs the call immediately).
    Attribution: the FIRST and LAST touch (utm_*, ad click ids, external referrer,
      landing page) are kept client-side for 90 days and ride on every beacon as
      `att`, so a goal or identify fired after the URL was cleaned still carries the
      campaign that brought the visitor. Safari caps script-written storage at 7 days
      of inactivity; the durable first touch lives server-side on the visitor profile.
    Engagement: on tab-hide / leave / SPA navigation an `engagement` beacon carries the
      engaged time and max scroll depth of the page being left (never counts as a pageview).
    Snippet attributes: data-auto, data-rage, data-internal, data-internal-paths,
      data-widget, data-autolead, data-harvest, data-require-consent, data-respect-dnt,
      data-hash (hash-based routers), data-domains (cross-domain linker), data-exclude
      (path globs that send nothing), data-allow-localhost, data-iframe,
      data-embed-origins, data-clarity, data-hotjar.
    Consent: by default the tracker collects everything with no banner required — you
      decide your own consent posture. data-require-consent="true" holds ALL events until
      you call mcph.consent('granted') (or 'denied'); the choice persists + queued events
      flush. data-require-consent="split" always sends basic pageview/goal analytics but
      gates session recordings/heatmaps + identification on mcph.consent('granted'), and
      uses only a session-scoped visitor id until consent is granted.
      mcph.consent('granted', false) is a JURISDICTION grant (the visitor is outside an
      opt-in regime): no consent record is written, but the `mcph_region` marker is, so
      later loads run fully from the first beacon. Remove that key when your own geo
      check puts the visitor inside a consent jurisdiction.
    Beacon path: data-endpoint="/your/path" posts to that same-origin path instead of
      /api/analytics/event (pair it with a rewrite on your side). Loaded as /m/s.js it
      posts to /api/m by default.
    Tracking subdomain: once your link.yourdomain.com is verified, the tracker moves
      its beacons there by itself (cached as `mcph_th:<tracker>`), even if the tag still
      loads from businessmcp.com.
    Custom goals:  window.mcph && mcph.track('signup', { plan: 'pro' })
    Revenue:       mcph.track('purchase', { revenue_cents: 4900 })
    Identify:      mcph.identify('user@domain.com', { name: 'Ada' })
    Autocapture (on by default): outbound-link clicks, file downloads, form submits
      (with detected purpose), mailto + tel clicks, button/CTA clicks, copy, JS errors,
      90% scroll depth, and clicks on [data-mcph-goal]/[data-goal]. Every goal carries
      its page path; pageviews flag returning visitors.
      Opt out with data-auto="false". Rage-clicks opt-in with data-rage="true". */
(function () {
  // document.currentScript is the reliable handle, but some loaders (e.g. Next
  // <Script strategy="afterInteractive">) can null it — fall back to a lookup.
  var s = document.currentScript || document.querySelector('script[data-tracker]')
  if (!s) return
  var tracker = s.getAttribute('data-tracker')
  if (!tracker) return
  // Sent as `v` on every beacon so the server knows which tracker build produced a
  // row. Mirrored by lib/analytics/tracker-version.ts (a test keeps them equal).
  var TRACKER_VERSION = '2.11.0'
  // Privacy signals. DNT is not legally binding, and GPC does NOT restrict first-party
  // analytics — it only governs "sale/sharing" to ad platforms (enforced server-side on
  // the CAPI / audience layer, gated by the Sec-GPC header + US state). So first-party
  // analytics runs regardless by default; a site can still opt IN to honoring the signal
  // with data-respect-dnt="true". `gpc` is forwarded as a fallback to the Sec-GPC header
  // so the ad-sharing suppression works even if the header is stripped.
  var gpc = navigator.globalPrivacyControl === true
  var dnt = gpc || navigator.doNotTrack === '1' || window.doNotTrack === '1'
  if (dnt && s.getAttribute('data-respect-dnt') === 'true') return
  // localhost / preview noise filter (data-allow-localhost="true" to debug an install).
  if (s.getAttribute('data-allow-localhost') !== 'true' && /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname)) return
  // POST back to the origin the script was served from.
  // data-endpoint: a same-origin beacon PATH (anything else is ignored); loaded as
  // /m/s.js the default is /api/m (both rewrites, next.config.mjs).
  var apiBase, endpoint, scriptBase, epPath, epExplicit
  try {
    var srcUrl = new URL(s.src)
    apiBase = scriptBase = srcUrl.origin
    epPath = s.getAttribute('data-endpoint') || ''
    epExplicit = /^\/[A-Za-z0-9/_-]*$/.test(epPath) && epPath.charAt(1) !== '/'
    if (!epExplicit) epPath = srcUrl.pathname === '/m/s.js' ? '/api/m' : '/api/analytics/event'
    endpoint = apiBase + epPath
  } catch (e) {
    return
  }
  // Cross-origin iframe guard: a page embedded in someone else's site would count a
  // pageview per embed and pin the PARENT page as its referrer for the whole session.
  // Autocapture pageviews are skipped there unless data-iframe="true"; the API still
  // works (a goal fired inside an embedded widget is still recorded). A same-origin
  // frame (top.location readable) is the site's own layout and counts as before.
  var inCrossFrame = false
  try {
    if (window.top !== window.self) {
      var topHref = window.top.location.href // throws cross-origin
      inCrossFrame = !topHref
    }
  } catch (e) {
    inCrossFrame = true
  }
  var autoPageviews = !(inCrossFrame && s.getAttribute('data-iframe') !== 'true')
  // data-exclude="/preview/*,/admin" — paths that send NOTHING (distinct from
  // data-internal-paths, which still records but flags the rows internal).
  var excludeRes = []
  try {
    var exRaw = (s.getAttribute('data-exclude') || '').split(',')
    for (var xi = 0; xi < exRaw.length; xi++) {
      var xg = exRaw[xi].trim()
      if (!xg) continue
      excludeRes.push(new RegExp('^' + xg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'))
    }
  } catch (e) {}
  function excluded(path) {
    for (var xr = 0; xr < excludeRes.length; xr++) if (excludeRes[xr].test(path)) return true
    return false
  }
  // Hash-based routers (#/pricing) — count a hash change as a route change.
  var hashRouting = s.getAttribute('data-hash') === 'true'
  // Cross-domain linker: other registrable domains of the same business (a separate
  // checkout or app domain). Links to them get `_mcph=<visitor id>.<ts>` appended so the
  // visitor keeps one id across both — no cookie involved. The other domain needs its
  // own tracker/site row; the linker only guarantees the SAME visitor id.
  var linkDomains = (s.getAttribute('data-domains') || '')
    .split(',')
    .map(function (d) { return d.trim().toLowerCase().replace(/^www\./, '') })
    .filter(Boolean)

  var auto = s.getAttribute('data-auto') !== 'false' // autocapture on by default
  var rage = s.getAttribute('data-rage') === 'true' // rage-click opt-in
  // Internal (own product/dashboard) traffic flagging. data-internal="1" flags the
  // whole site; data-internal-paths="/dashboard,/onboarding" flags by path prefix,
  // evaluated PER BEACON — the attribute-only flag was read once at script load, so a
  // session starting on a marketing page that SPA-navigated into the app sent its
  // in-app pageviews unflagged (the "founder counts as a visitor" bug, 2026-08-15).
  var internalAll = s.getAttribute('data-internal') === '1'
  var internalPaths = (s.getAttribute('data-internal-paths') || '')
    .split(',')
    .map(function (p) { return p.trim() })
    .filter(Boolean)
  // `path` defaults to the current location; hm.js passes an explicit path so a
  // scroll-depth commit for the page just LEFT is judged on that page, not the new one.
  function isInternal(path) {
    var p = path || location.pathname
    if (internalAll) return true
    for (var ii = 0; ii < internalPaths.length; ii++) {
      if (p.indexOf(internalPaths[ii]) === 0) return true
    }
    return false
  }
  var widgetOn = s.getAttribute('data-widget') !== 'false' // support widget on by default
  // WebMCP (W3C, Google + Microsoft): hand an on-page agent a list of callable
  // tools instead of making it read the DOM. OFF by default and opt-in with
  // data-webmcp="true" — enabling it injects a Chrome origin-trial meta tag into
  // the host page, which changes that page's browser feature surface, and a
  // side effect on someone else's document is asked for, not assumed. (Contrast
  // data-auto, which is opt-OUT because it only reads what is already there.)
  var webmcpOn = s.getAttribute('data-webmcp') === 'true'
  var autolead = s.getAttribute('data-autolead') !== 'false' // native-form email capture
  var harvest = s.getAttribute('data-harvest') !== 'false' // same-origin identity harvest (consent-gated)

  // Consent gating (opt-in; off by default — DNT/GPC above already covers the baseline
  // privacy signal). Two gated modes via data-require-consent:
  //   "true"  ('all')   — hold EVERY event (queued, not sent) until the site calls
  //                       window.mcph.consent('granted').
  //   "split" ('split') — basic pageview/goal/revenue analytics always send (legitimate
  //                       interest); identify events + session recordings/heatmaps wait
  //                       for granted consent, and the visitor id stays session-scoped
  //                       until then.
  // Honors a prior choice persisted in localStorage and Google Consent Mode's
  // analytics_storage if present.
  // `mcph_region` = a JURISDICTION grant (consent('granted', false)): where the visitor
  // is, never a consent record (Art. 7(1)). Without it every non-EU load minted a new
  // id and overwrote the first touch. The site's geo check / a denial removes it.
  var REGION_KEY = 'mcph_region'
  var consentAttr = s.getAttribute('data-require-consent')
  var consentMode = consentAttr === 'true' ? 'all' : consentAttr === 'split' ? 'split' : 'off'
  var requireConsent = consentMode !== 'off'
  var consentState = requireConsent ? 'pending' : 'granted' // 'granted' | 'denied' | 'pending'
  try {
    var stored = localStorage.getItem('mcph_consent')
    if (stored === 'granted') consentState = 'granted'
    else if (stored === 'denied') consentState = 'denied'
    else if (requireConsent && localStorage.getItem(REGION_KEY) === 'open') consentState = 'granted'
    // Respect Google Consent Mode if the site already set it to granted.
    else if (requireConsent && window.dataLayer) {
      for (var ci = 0; ci < window.dataLayer.length; ci++) {
        var d = window.dataLayer[ci]
        if (d && d[0] === 'consent' && d[2] && d[2].analytics_storage === 'granted') consentState = 'granted'
      }
    }
  } catch (e) {}
  // Recording layers (hm.js replay/heatmaps + Clarity/Hotjar) need granted consent in
  // BOTH gated modes — they're the privacy-sensitive layer the consent ask is about.
  function consentBlocksRecording() {
    return requireConsent && consentState !== 'granted'
  }

  // Persistent, anonymous visitor id (localStorage) — links a visitor's sessions
  // across days/pages for attribution, and is passed into checkout for revenue.
  // Reads the short-lived `as_vid` key as a fallback so visitors from that window
  // aren't reset. Split mode + consent not granted: the id is SESSION-scoped only
  // (sessionStorage); on mcph.consent('granted') the same value is promoted to
  // localStorage so the pre-consent journey stays stitched.
  // Session-scoping narrows exposure but is NOT ePrivacy-exempt (Art. 5(3) covers
  // sessionStorage too); defensible posture = data-require-consent="true".
  var vid
  var isReturning = false
  function mintVid() { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) }
  // Cross-domain linker landing: `?_mcph=<vid>.<ts36>` from a sibling domain listed in
  // its data-domains. Adopted only when fresh (< 2 min) and this browser has no
  // persistent id yet, then stripped from the URL (the native replaceState — the SPA
  // hook below is not installed yet, so this never counts as a pageview).
  var linkedVid = null
  try {
    var lm = /[?&]_mcph=([A-Za-z0-9]+)\.([a-z0-9]+)(&|$)/.exec(location.search)
    if (lm && Math.abs(Date.now() - parseInt(lm[2], 36)) < 120000) linkedVid = lm[1]
    if (lm) {
      var cleanUrl = location.pathname + location.search.replace(/([?&])_mcph=[^&]*&?/, '$1').replace(/[?&]$/, '') + location.hash
      history.replaceState(history.state, '', cleanUrl)
    }
  } catch (e) {}
  // The id is minted in memory FIRST — a storage throw (Safari private mode, a
  // partitioned third-party context) used to leave `vid` undefined, which silently
  // made heatmap sampling site-wide.
  try {
    if (consentMode === 'split' && consentState !== 'granted') {
      try { vid = sessionStorage.getItem('mcph_vid') } catch (e) {}
      if (!vid) {
        vid = linkedVid || mintVid()
        try { sessionStorage.setItem('mcph_vid', vid) } catch (e) {}
      }
      // isReturning stays false — without a persistent id we can't know.
    } else {
      try { vid = localStorage.getItem('mcph_vid') || localStorage.getItem('as_vid') } catch (e) {}
      isReturning = !!vid // an existing id means we've seen this visitor before
      if (!vid) vid = linkedVid || mintVid()
      try { localStorage.setItem('mcph_vid', vid) } catch (e) {}
    }
  } catch (e) {}
  if (!vid) vid = mintVid()

  // Session id (the GA rule): one id per run of activity, rotated after 30 idle minutes,
  // shared by every tab through the same storage tier as the visitor id. The server keys
  // sessions on visitor id + this, not on ip+ua, which merged everyone behind one office
  // NAT into one session and split a person whose IP changed. A leave beacon never
  // rotates it (`rotate` false) but does refresh it: its engaged time proves the visitor
  // was there, so a 40-minute read and the click after it are one visit — but only when
  // that engaged time actually covers the gap (`engagedMs`). A leave beacon from a tab
  // that sat idle for hours used to refresh the clock too, so the next page in that tab
  // (typed URL, next morning) continued the old visit and inherited its source.
  // iPadOS reports a desktop Macintosh UA; touch points are how the server tells (detect.ts).
  var TOUCH = false
  try { TOUCH = (navigator.maxTouchPoints || 0) > 1 } catch (e) {}
  var SSK = 'mcph_ss', ssMem = null
  function sessionId(rotate, engagedMs) {
    var now = Date.now(), id = null, last = 0, st = null
    try { st = consentMode === 'split' && consentState !== 'granted' ? sessionStorage : localStorage } catch (e) {}
    try {
      var raw = st && st.getItem(SSK)
      if (raw) { var sp = String(raw).split('.'); id = sp[0]; last = parseInt(sp[1], 36) || 0 }
    } catch (e) {}
    if (!id && ssMem) { id = ssMem.id; last = ssMem.last }
    var valid = /^s[a-z0-9]{6,24}$/.test(id || '')
    var expired = now - last > 1800000
    // An expired visit seen by a non-rotating call (a leave beacon) keeps its id, and keeps
    // its clock unless the engaged time proves the visitor was there across the gap.
    if (valid && expired && !rotate && !((engagedMs || 0) >= now - last - 1800000)) return id
    if (!valid || (rotate && expired)) id = 's' + now.toString(36) + Math.random().toString(36).slice(2, 8)
    last = now
    ssMem = { id: id, last: last }
    try { if (st) st.setItem(SSK, id + '.' + last.toString(36)) } catch (e) {}
    return id
  }

  function clamp(v) {
    return v == null ? v : String(v).slice(0, 200)
  }

  // Goal-name hygiene (mirrors DataFast's rules) so custom-goal data stays clean and
  // classifies well: lowercase, safe chars [a-z0-9_:-], spaces→_, max 64. Returns ''
  // for the reserved 'identify' name (callers should use mcph.identify instead).
  function normGoal(name) {
    var n = String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_:-]/g, '').slice(0, 64)
    // Reserved: the beacon types the server treats specially (lib/analytics/goal-name.ts is the twin).
    return n === 'identify' || n === 'pageview' || n === 'engagement' ? '' : n
  }
  // Cap custom-goal metadata to keep beacons lean + mirror DataFast limits: <=10 keys,
  // string values <=255 chars. revenue_cents (a number the backend needs) passes through.
  function capMeta(meta) {
    if (!meta || typeof meta !== 'object') return meta
    var out = {}, n = 0, keys = []
    for (var k in meta) {
      if (!Object.prototype.hasOwnProperty.call(meta, k)) continue
      if (k === 'revenue_cents') { out[k] = meta[k]; continue }
      if (n >= 10) continue
      var v = meta[k]
      if (v == null) continue
      // Nested objects are flattened to a string: the server caps the whole beacon at
      // 8KB and answers 413, which the browser never retries — so an unbounded object
      // here meant a silently dropped goal.
      var sv = ''
      if (typeof v === 'object') { try { sv = JSON.stringify(v) } catch (e) { sv = '' } } else sv = String(v)
      out[k] = sv.slice(0, 255)
      keys.push(k)
      n++
    }
    // Total metadata budget 4KB — drop the last-added keys until it fits.
    try {
      while (keys.length && JSON.stringify(out).length > 4096) delete out[keys.pop()]
    } catch (e) {}
    return out
  }

  // Cheap client-side automation signals — headless/Puppeteer/Playwright often
  // spoof a clean user-agent, so the server can't see them from the UA alone.
  // Computed once; attached to every beacon's metadata (only when non-empty) so the
  // backend can fold them into its bot decision. Conservative: never guesses.
  var BOTSIG = (function () {
    var sig = {}
    try { if (navigator.webdriver === true) sig.webdriver = 1 } catch (e) {}
    try { if (!navigator.languages || navigator.languages.length === 0) sig.noLanguages = 1 } catch (e) {}
    try { if (/Chrome\/\d/.test(navigator.userAgent) && !window.chrome) sig.noChrome = 1 } catch (e) {}
    try { if (/Headless/i.test(navigator.userAgent)) sig.headlessUa = 1 } catch (e) {}
    return sig
  })()
  // ---- Agentic-browser signals (AGENTSIG) ------------------------------
  // Deliberately SEPARATE from BOTSIG. BOTSIG catches headless/webdriver
  // automation; an agentic browser (Comet, ChatGPT Atlas) is a real, visible
  // Chromium with none of those markers, so mixing them would make the
  // automation gate fire on real people.
  //
  // COLLECTION ONLY. lib/analytics/agent-signals.ts records what these mean and
  // deliberately draws no conclusion from the behavioural ones until they have
  // been measured against a real agent session — see the comment there.
  var AGENTSIG = {}
  ;(function () {
    try {
      var sawMove = false, sawFocus = false, ready = Date.now(), acted = false
      addEventListener('pointermove', function () { sawMove = true }, { passive: true, capture: true })
      addEventListener('focus', function () { sawFocus = true }, { capture: true })
      addEventListener('blur', function () { sawFocus = true }, { capture: true })
      addEventListener('click', function (e) {
        if (!acted) { acted = true; AGENTSIG.firstActionMs = Date.now() - ready }
        if (!sawMove) AGENTSIG.noPointerPath = 1
        if (!sawFocus) AGENTSIG.noFocusEvents = 1
        try {
          var t = e.target && e.target.getBoundingClientRect && e.target.getBoundingClientRect()
          // A pointer landing within 2px of the exact centre is a computed
          // coordinate, not a hand. Skipped for a tiny target, where the centre
          // is most of the element and a human hits it routinely.
          if (t && t.width > 8 && t.height > 8 &&
              Math.abs(e.clientX - (t.left + t.width / 2)) <= 2 &&
              Math.abs(e.clientY - (t.top + t.height / 2)) <= 2) AGENTSIG.centreClick = 1
        } catch (e2) {}
      }, { passive: true, capture: true })
      // The brand list a Chromium derivative may name itself in. Recorded raw;
      // nothing matches it yet, because no agentic browser is confirmed to
      // publish one and a guess here would re-label real visitors.
      var uad = navigator.userAgentData
      if (uad && uad.brands && uad.brands.length) {
        AGENTSIG.brands = uad.brands.map(function (b) { return b.brand }).join(',').slice(0, 200)
      }
    } catch (e) {}
  })()

  function hasKeys(o) { for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) return true } return false }
  // Mirror lib/analytics/detect.ts:looksAutomated — webdriver alone, or ≥2 weak signals.
  // Used to skip loading hm.js for headless/automation sessions (server re-checks too).
  function botsigAutomated() {
    if (BOTSIG.webdriver === 1) return true
    var weak = (BOTSIG.noLanguages === 1 ? 1 : 0) + (BOTSIG.noChrome === 1 ? 1 : 0) + (BOTSIG.headlessUa === 1 ? 1 : 0)
    return weak >= 2
  }

  // Deterministic [0,100) bucket for sampling — MUST match lib/heatmaps/limits.ts
  // sampleBucket() so the client's capture decision and the server's re-enforcement
  // agree. FNV-1a 32-bit → mod 100.
  function sampleBucket(seed) {
    var h = 0x811c9dc5
    for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) }
    return (h >>> 0) % 100
  }
  function passesSample(seed, rate) {
    if (rate >= 100) return true
    if (rate <= 0) return false
    return sampleBucket(String(seed || tracker)) < rate
  }

  // Offline/retry queue: a failed beacon (poor network, sendBeacon over quota) is
  // stashed in localStorage and re-sent on the next pageview / when connectivity
  // returns — so flaky mobile sessions don't silently undercount. Bounded so a long
  // offline stretch can't grow unbounded.
  var QK = 'mcph_q', QMAX = 50
  function enqueue(body) {
    try {
      var q = JSON.parse(localStorage.getItem(QK) || '[]')
      if (!Array.isArray(q)) q = []
      q.push(body)
      if (q.length > QMAX) q = q.slice(q.length - QMAX)
      localStorage.setItem(QK, JSON.stringify(q))
    } catch (e) {}
  }
  // Remove ONE queued body (by value) — the queue key is rewritten only after a
  // beacon actually got through. It used to be cleared BEFORE the sends fired, so a
  // tab closed mid-flight lost every queued event for good.
  function dequeue(body) {
    try {
      var q = JSON.parse(localStorage.getItem(QK) || '[]')
      if (!Array.isArray(q)) return
      var i = q.indexOf(body)
      if (i < 0) return
      q.splice(i, 1)
      if (q.length) localStorage.setItem(QK, JSON.stringify(q))
      else localStorage.removeItem(QK)
    } catch (e) {}
  }
  // A response that will never succeed on retry (400 bad input, 413 too large) is
  // dropped; 429 and 5xx are transient and stay queued.
  function retryable(status) { return status === 429 || status >= 500 || status === 0 }
  var flushing = false
  function flush() {
    // 'all' mode holds everything until granted. 'split' flushes base events anytime
    // (the queue doubles as the offline-retry buffer) but holds identify events back
    // until consent is granted.
    if (consentMode !== 'split' && consentState !== 'granted') return
    if (flushing) return
    var hidden = false
    try { hidden = document.visibilityState === 'hidden' } catch (e) {}
    // The queue is shared by every tab of the site: two tabs opening at once each sent the
    // whole queue. A Web Lock lets one tab flush at a time (the other skips; its next
    // flush finds what is left). Not on page-leave, where only a synchronous send survives.
    try {
      if (!hidden && navigator.locks && navigator.locks.request) {
        flushing = true
        navigator.locks.request(QK, { ifAvailable: true }, function (lock) {
          if (!lock) { flushing = false; return }
          return new Promise(function (done) { flushNow(false, done) })
        }).catch(function () { flushing = false })
        return
      }
    } catch (e) {}
    flushNow(hidden)
  }
  function flushNow(hidden, done) {
    var q
    try {
      q = JSON.parse(localStorage.getItem(QK) || '[]')
      if (!Array.isArray(q) || !q.length) q = []
    } catch (e) { q = [] }
    if (!q.length) { flushing = false; if (done) done(); return }
    flushing = true
    var pending = 0
    function settled() { flushing = false; if (done) done() }
    q.forEach(function (orig) {
      var b = orig
      try {
        var p = null
        try { p = JSON.parse(b) } catch (e2) {}
        if (p) {
          if (consentMode === 'split') {
            if (p.type === 'identify' && consentState !== 'granted') return // hold until Accept
            p.consent = consentState // re-stamp: queued earlier, sent under the CURRENT state
          }
          p.rq = 1 // a re-send: the server dedupes it by eid and files it under its own ts
          b = JSON.stringify(p)
        }
        // Leaving the page: sendBeacon is the only transport that reliably survives.
        if (hidden && navigator.sendBeacon) {
          if (navigator.sendBeacon(endpoint, new Blob([b], { type: 'text/plain' }))) dequeue(orig)
          return
        }
        // text/plain is CORS-safelisted → no preflight (application/json would force a
        // preflight that fails cross-origin against ACAO:* + sendBeacon's credentials mode,
        // silently dropping the beacon). The server reads the raw body + JSON.parses it.
        pending++
        fetch(endpoint, { method: 'POST', body: b, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
          .then(function (r) { if (r && (r.ok || !retryable(r.status))) dequeue(orig) })
          .catch(function () {})
          .then(function () { if (--pending === 0) settled() })
      } catch (e) {}
    })
    if (!pending) settled()
  }

  // Client corroborators for the IP graph: the browser's time zone (its country vs
  // the IP's country exposes a VPN/edge/SASE egress), languages, and the connection
  // type where the platform reports it (a cellular line is never a company). Read
  // once; sent on pageviews + identifies only. Never used as a gate on its own.
  var ENV = {}
  try { var tzn = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tzn) ENV.tz = String(tzn).slice(0, 64) } catch (e) {}
  try { var ls = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]; ENV.langs = ls.filter(Boolean).slice(0, 3).join(',').slice(0, 40) } catch (e) {}
  try {
    var nc = navigator.connection || navigator.mozConnection || navigator.webkitConnection
    if (nc) {
      var ct = nc.type ? String(nc.type) : ''
      var et = nc.effectiveType ? String(nc.effectiveType) : ''
      if (ct || et) ENV.conn = (ct && et ? ct + '/' + et : ct || et).slice(0, 24)
    }
  } catch (e) {}

  function send(payload, acquisition) {
    // An engagement beacon describes the page being LEFT — judge exclude/internal on it.
    var onPath = location.pathname
    if (payload.type === 'engagement' && payload.url) { try { onPath = new URL(payload.url).pathname } catch (e) {} }
    if (excluded(onPath)) return // data-exclude: nothing leaves the page
    payload.trackerId = tracker
    payload.v = TRACKER_VERSION
    // Every beacon carries its own id and time: a queued re-send of one that already
    // landed is recognised server-side, and is filed under when it happened.
    if (!payload.eid) payload.eid = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    payload.ts = Date.now()
    if (hashRouting) payload.hr = 1
    payload.ss = sessionId(payload.type !== 'engagement', payload.engaged_ms)
    if (TOUCH) payload.mt = 1
    if (!payload.url) payload.url = location.href // engagement passes the page being LEFT
    if (vid) payload.visitorId = vid
    if ((payload.type === 'pageview' || payload.type === 'identify') && hasKeys(ENV)) payload.env = ENV
    // First/last touch ride on every beacon.
    var attBlock = attForBeacon(false)
    if (attBlock) payload.att = attBlock
    // Fallback for the Sec-GPC request header (the server prefers the header). Only used
    // to suppress third-party ad-sharing (CAPI/audiences), never to drop analytics.
    if (gpc) payload.gpc = 1
    if (isInternal(onPath) && !acquisition) {
      payload.metadata = payload.metadata || {}
      payload.metadata.internal = 1
    }
    if (hasKeys(BOTSIG)) {
      payload.metadata = payload.metadata || {}
      payload.metadata.bot_signals = BOTSIG
    }
    // Split mode stamps the consent state on every beacon so the server can gate
    // consent-bound processing (enrichment IP capture). Absent for default snippets
    // and 'all' mode (where nothing transmits pre-consent anyway).
    if (consentMode === 'split') payload.consent = consentState
    var body = JSON.stringify(payload)
    if (consentMode === 'split') {
      // Base analytics (pageview/goal/revenue) always send; identify waits for consent —
      // queued while the choice is pending (flushes on Accept), dropped once denied.
      if (payload.type === 'identify' && consentState !== 'granted') {
        if (consentState === 'pending') enqueue(body)
        return
      }
    } else if (consentState !== 'granted') {
      // 'all' mode: consent not yet granted → queue (don't transmit) until the site grants it.
      enqueue(body)
      return
    }
    try {
      if (navigator.sendBeacon) {
        // Blob type MUST be text/plain (a CORS-safelisted content type), NOT application/json.
        // sendBeacon always sends credentials mode 'include'; a non-safelisted content type forces
        // a CORS preflight, and our ACAO:* response is invalid for a credentialed request → the
        // preflight fails and the beacon is dropped (net::ERR_FAILED) while sendBeacon() still
        // returns true, so we'd never retry. text/plain = a "simple request" → no preflight → it
        // reaches the server (which reads the raw body + JSON.parses it, ignoring Content-Type).
        if (navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return
      }
    } catch (e) {}
    try {
      // A 413/400 will never succeed on retry — only network failures, 429 and 5xx queue.
      fetch(endpoint, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
        .then(function (r) { if (r && !r.ok && retryable(r.status)) enqueue(body) })
        .catch(function () { enqueue(body) })
      return
    } catch (e) {}
    enqueue(body) // last resort: neither transport available right now
  }

  // First-touch referrer persistence. A client-side redirect / SPA route change can blank
  // out document.referrer (or make it a self-referral) by the time a later pageview fires,
  // which mis-attributes real search/referral traffic as Direct. So we stash the session's
  // FIRST external referrer in sessionStorage and reuse it whenever the live value is empty
  // or same-origin — but ONLY inside the session that saw it (`<ss>|<ref>`). sessionStorage
  // lives as long as the TAB, so an unkeyed stash pinned one referrer onto every later
  // visit from a tab kept open, restored or duplicated: a direct return read as AI.
  var REF0 = 'mcph_ref0'
  // Registrable domain of a host: the last two labels, or three under a short list of
  // two-part public suffixes (co.uk, com.au, …). blog.acme.com and acme.com are ONE
  // site — the old exact-host compare recorded a subdomain hop as an external referral
  // and pinned it as the session's first touch. Pure (params only) so it is unit-testable.
  function regDomain(host) {
    var h = String(host || '').toLowerCase().replace(/\.$/, '')
    var parts = h.split('.')
    if (parts.length <= 2) return h
    var tail2 = parts.slice(-2).join('.')
    var n = /^(co|com|org|net|ac|gov|edu)\.(uk|au|jp|br|nz|za|mx|in|sg|hk|il|tr|ar|id|my|kr|tw)$/.test(tail2) ? 3 : 2
    return parts.slice(-n).join('.')
  }
  function sameHost(h) {
    try {
      return regDomain(h) === regDomain(location.hostname)
    } catch (e) {
      return false
    }
  }
  // Verified tracking subdomain: config names it, later beacons (and, cached, the next
  // load's first) move onto it. Only a host on the page's own domain is accepted, and
  // config is fetched from the script origin so an unverified host gets cleared.
  var TH_KEY = 'mcph_th:' + tracker
  var HOST_OK = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
  function thStore() { return requireConsent && consentState !== 'granted' ? sessionStorage : localStorage }
  function useTrackingHost(h, remember) {
    try {
      h = String(h || '').toLowerCase()
      if (!HOST_OK.test(h) || !sameHost(h)) return false
      if (remember) { try { thStore().setItem(TH_KEY, h) } catch (e) {} }
      if ('https://' + h === apiBase) return true
      apiBase = 'https://' + h
      endpoint = apiBase + (epExplicit ? epPath : '/api/m')
      return true
    } catch (e) {
      return false
    }
  }
  function forgetTrackingHost() {
    try { sessionStorage.removeItem(TH_KEY) } catch (e) {}
    try { localStorage.removeItem(TH_KEY) } catch (e) {}
  }
  try {
    var thCached = null
    try { thCached = sessionStorage.getItem(TH_KEY) } catch (e) {}
    if (!thCached && !(requireConsent && consentState !== 'granted')) thCached = localStorage.getItem(TH_KEY)
    if (thCached) useTrackingHost(thCached, false)
  } catch (e) {}
  // Sign-in / checkout returns are the same visit, never a touch (accounts.google.com
  // read as Organic Search). ≡ lib/analytics/detect.ts:AUTH_RETURN_HOST (parity test).
  var AUTH_RETURN = /^(accounts\.google\.[a-z.]+|accounts\.youtube\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|checkout\.stripe\.com|billing\.stripe\.com|pay\.stripe\.com|[a-z0-9-]+\.supabase\.co)$/i
  function externalRefHost(h) {
    return !!h && !sameHost(h) && !AUTH_RETURN.test(h)
  }
  function effectiveReferrer(rotate) {
    var ss = sessionId(rotate !== false)
    var dr = document.referrer || ''
    var ext = ''
    if (dr) {
      var host = ''
      try {
        host = new URL(dr).hostname
      } catch (e) {
        host = ''
      }
      if (externalRefHost(host)) ext = dr // a real, external referrer
    }
    try {
      var held = String(sessionStorage.getItem(REF0) || '')
      var mine = held.indexOf(ss + '|') === 0 ? held.slice(ss.length + 1) : ''
      if (ext) {
        if (!mine) sessionStorage.setItem(REF0, ss + '|' + ext)
        return ext
      }
      return mine // the session's first touch; a stash from an earlier session is stale
    } catch (e) {
      return ext
    }
  }

  // ---- First / last touch attribution (client-side persistence) -------------------
  // The server derives utm_* and ad click ids from the beacon URL only, so a goal fired
  // after the query string was cleaned (SPA navigation, a redirect, a thank-you page)
  // used to lose the campaign entirely. We keep the landing's touch here and attach it
  // to every beacon as `att`: `ft` = first touch (written once, 90d), `lt` = last touch
  // (replaced whenever a visit arrives with a campaign or an external referrer; a plain
  // direct return keeps the previous campaign, GA-style). Split-consent sites store it
  // session-scoped until consent is granted, exactly like the visitor id.
  var ATT_KEY = 'mcph_att', ATT_TTL = 90 * 86400000
  var ATT_IDS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'dclid', 'fbclid', 'ttclid', 'twclid', 'li_fat_id', 'igshid', 'epik', 'srsltid']
  var ATT_UTM = { utm_source: 'src', utm_medium: 'med', utm_campaign: 'cmp', utm_term: 'term', utm_content: 'content', utm_id: 'id' }
  function attStore() { return consentMode === 'split' && consentState !== 'granted' ? sessionStorage : localStorage }
  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
      return m ? decodeURIComponent(m[1]).slice(0, 200) : null
    } catch (e) { return null }
  }
  // Meta's server-side click id: fb.1.<ms>.<fbclid> — minted here when the pixel is not
  // on the page to set `_fbc` itself. Pure (params only) so it is unit-testable.
  function mintFbc(fbclid, tsMs) {
    return fbclid ? 'fb.1.' + tsMs + '.' + String(fbclid).slice(0, 200) : null
  }
  // The touch described by THIS landing: utm_*, click ids, external referrer, landing path.
  function attFromLanding() {
    // `ss` lets the server tell a last touch from THIS visit from one carried over from an
    // earlier visit (attribution-touch.ts: only a same-session touch may set the channel).
    var t = { lp: location.pathname.slice(0, 200), ts: Date.now(), ss: sessionId(true) }
    var tagged = false
    try {
      var qp = new URLSearchParams(location.search)
      for (var uk in ATT_UTM) {
        var uv = qp.get(uk)
        if (uv) { t[ATT_UTM[uk]] = String(uv).slice(0, 200); tagged = true }
      }
      // `?ref=` (Product Hunt, newsletters, our own share links) names a source when no
      // utm_source does: the common convention, and what makes a shared link measurable.
      if (!t.src) {
        var rv = qp.get('ref')
        if (rv && /^[\w.-]{1,64}$/.test(rv)) { t.src = rv; tagged = true }
      }
      for (var ai = 0; ai < ATT_IDS.length; ai++) {
        var iv = qp.get(ATT_IDS[ai])
        if (iv) { t.ids = t.ids || {}; t.ids[ATT_IDS[ai]] = String(iv).slice(0, 200); tagged = true }
      }
    } catch (e) {}
    try {
      var dr = document.referrer || ''
      var rh = dr ? new URL(dr).hostname : ''
      if (externalRefHost(rh)) { t.ref = dr.slice(0, 200); tagged = true }
    } catch (e) {}
    t.tagged = tagged
    return t
  }
  var ATT = { ft: null, lt: null }
  function attLoad() {
    try {
      var raw = JSON.parse(attStore().getItem(ATT_KEY) || 'null')
      if (raw && typeof raw === 'object') {
        var now = Date.now()
        if (raw.ft && now - (raw.ft.ts || 0) < ATT_TTL) ATT.ft = raw.ft
        if (raw.lt && now - (raw.lt.ts || 0) < ATT_TTL) ATT.lt = raw.lt
      }
    } catch (e) {}
  }
  function attSave() {
    try { attStore().setItem(ATT_KEY, JSON.stringify(ATT)) } catch (e) {}
  }
  // Cookie-derived Meta ids are identity-class data: read only when identify may run.
  function attCookies(target) {
    if (requireConsent && consentState !== 'granted') return
    var fbc = readCookie('_fbc'), fbp = readCookie('_fbp')
    if (!fbc && target && target.ids && target.ids.fbclid) fbc = mintFbc(target.ids.fbclid, target.ts)
    if (fbc) target.fbc = fbc
    if (fbp) target.fbp = fbp
  }
  function attInit() {
    attLoad()
    var cur = attFromLanding()
    var tagged = cur.tagged
    delete cur.tagged
    if (!ATT.ft) ATT.ft = cur
    if (tagged || !ATT.lt) ATT.lt = cur
    if (ATT.lt === cur || !ATT.lt.fbc) attCookies(ATT.lt)
    attSave()
  }
  attInit()
  // On a grant, MERGE into the persistent store: an older first touch there wins.
  function attPromote() {
    try {
      var prev = JSON.parse(localStorage.getItem(ATT_KEY) || 'null')
      var pft = prev && prev.ft
      if (pft && Date.now() - (pft.ts || 0) < ATT_TTL && (!ATT.ft || (pft.ts || 0) < (ATT.ft.ts || 0))) ATT.ft = pft
      // The same rule attInit applies: an untagged visit never replaces the last touch.
      var plt = prev && prev.lt, cl = ATT.lt
      var curTagged = cl && (cl.src || cl.med || cl.cmp || cl.ref || cl.ids)
      if (plt && Date.now() - (plt.ts || 0) < ATT_TTL && !curTagged) ATT.lt = plt
    } catch (e) {}
    try { if (ATT.lt) attCookies(ATT.lt) } catch (e) {}
    attSave()
  }
  function attForBeacon(lastOnly) {
    if (!ATT.lt) return null
    return lastOnly ? { lt: ATT.lt } : { ft: ATT.ft || ATT.lt, lt: ATT.lt }
  }

  // ---- Engagement (time + scroll depth of the page being left) -------------------
  // Visible-time accumulator: starts on pageview / tab-visible, pauses on tab-hidden.
  // Reported as DELTAS (the accumulator resets after each send) so the server can sum.
  var engAcc = 0, engStart = 0, engVisible = false, maxScroll = 0, sentScroll = -1
  function engagedMs() { return engAcc + (engVisible ? Date.now() - engStart : 0) }
  function pageHidden() { try { return document.visibilityState === 'hidden' } catch (e) { return false } }
  // Never (re)start the clock while the tab is hidden — the visibilitychange handler
  // resumes it when the page is shown again.
  function engResume() { if (!engVisible && !pageHidden()) { engVisible = true; engStart = Date.now() } }
  function engPause() { if (engVisible) { engAcc += Date.now() - engStart; engVisible = false } }
  function scrollPct() {
    try {
      var d = document.documentElement
      var full = Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0)
      if (!full) return 0
      var seen = (window.scrollY || d.scrollTop || 0) + window.innerHeight
      // floor: round() reported 87.5% as 90
      return Math.max(0, Math.min(100, Math.floor((seen / full) * 20) * 5))
    } catch (e) { return 0 }
  }
  // Seeded by seedScroll() after render: inside pushState the old page is on screen.
  function engReset() { engAcc = 0; engVisible = false; maxScroll = 0; sentScroll = -1; userScrolled = false; engResume() }
  function seedScroll() { var p = scrollPct(); if (p > maxScroll) maxScroll = p }
  // scroll_90 needs a real gesture (scroll restoration / short pages report 90%+ unscrolled).
  var userScrolled = false
  try {
    ['wheel', 'touchmove', 'keydown'].forEach(function (t) {
      window.addEventListener(t, function (ev) {
        if (t === 'keydown') {
          var k = ev && ev.key
          if (k !== 'PageDown' && k !== 'End' && k !== 'ArrowDown' && k !== ' ' && k !== 'Spacebar') return
        }
        userScrolled = true
      }, { passive: true, capture: true })
    })
  } catch (e) {}
  // Core Web Vitals, best-effort via buffered PerformanceObservers (nothing throws:
  // an unsupported entry type is caught and simply not reported). Reported once per
  // page LOAD on that load's first engagement beacon — they describe the navigation,
  // not an SPA route. Capture-only on the server (metadata.vitals / metadata.dpr).
  var vitals = {}
  var clsRaw = null
  var vitalsSent = false
  try {
    var navEntry = performance.getEntriesByType && performance.getEntriesByType('navigation')[0]
    if (navEntry && navEntry.responseStart > 0) vitals.ttfb = Math.round(navEntry.responseStart)
  } catch (e) {}
  function observeVital(opts, fn) {
    try {
      var po = new PerformanceObserver(function (list) {
        try { list.getEntries().forEach(fn) } catch (e) {}
      })
      po.observe(opts)
    } catch (e) {}
  }
  if (window.PerformanceObserver) {
    observeVital({ type: 'largest-contentful-paint', buffered: true }, function (en) { vitals.lcp = Math.round(en.startTime) })
    observeVital({ type: 'layout-shift', buffered: true }, function (en) { if (!en.hadRecentInput) clsRaw = (clsRaw || 0) + en.value })
    observeVital({ type: 'event', buffered: true, durationThreshold: 40 }, function (en) {
      var d = Math.round(en.duration)
      if (!(vitals.inp >= d)) vitals.inp = d
    })
  }
  function vitalsForBeacon() {
    if (vitalsSent) return null
    vitalsSent = true
    var out = {}, any = false
    for (var vk in vitals) { if (Object.prototype.hasOwnProperty.call(vitals, vk)) { out[vk] = vitals[vk]; any = true } }
    if (clsRaw != null) { out.cls = Math.round(clsRaw * 1000) / 1000; any = true }
    return any ? out : null
  }

  function sendEngagement(url) {
    if (!url) return
    engPause()
    var ms = Math.round(engAcc)
    engAcc = 0
    if (maxScroll > 100) maxScroll = 100
    if (ms < 1000 && maxScroll <= Math.max(sentScroll, 0)) { engResume(); return } // nothing new to report
    sentScroll = maxScroll
    var payload = { type: 'engagement', url: url, referrer: effectiveReferrer(false), engaged_ms: ms, scroll_pct: maxScroll }
    var vit = vitalsForBeacon()
    if (vit) payload.vitals = vit
    // AGENTSIG rides the LEAVE beacon, not the pageview: a click cannot have
    // happened before the page loads, so sending it on the pageview would ship
    // an empty object every time.
    if (hasKeys(AGENTSIG)) payload.agent_signals = AGENTSIG
    try { payload.dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100 } catch (e) {}
    send(payload)
    engResume()
  }

  function goal(name, meta) {
    var m = {}
    for (var mk in meta) if (Object.prototype.hasOwnProperty.call(meta, mk)) m[mk] = meta[mk] // never mutate the caller's object
    if (m.path == null) m.path = location.pathname // every goal carries its page
    send({ type: 'goal', name: name, referrer: effectiveReferrer(), metadata: m })
  }

  // Infer a form's purpose from its field names/types so "form submit" isn't vague.
  function formPurpose(f) {
    try {
      var els = f.elements || []
      var hasEmail = false, hasPassword = false, hasName = false, hasMsg = false, hasPay = false, txt = ''
      for (var i = 0; i < els.length; i++) {
        var el = els[i]
        if (!el) continue
        var key = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.type || '') + ' ' + (el.placeholder || '')).toLowerCase()
        txt += key + ' '
        if (el.type === 'email' || /e-?mail/.test(key)) hasEmail = true
        if (el.type === 'password' || /password/.test(key)) hasPassword = true
        if (/\bname\b|first|last|company/.test(key)) hasName = true
        if (/message|comment|subject|inquiry|enquiry/.test(key)) hasMsg = true
        if (/card|cvc|cvv|billing|cart|quantity|checkout|coupon/.test(key)) hasPay = true
      }
      txt += ' ' + ((f.getAttribute('name') || '') + ' ' + (f.id || '') + ' ' + (f.action || '')).toLowerCase()
      if (hasPay) return 'checkout'
      if (hasPassword && /(sign[\s_-]?up|register|create)/.test(txt)) return 'signup'
      if (hasPassword) return 'login'
      if (hasEmail && (hasName || hasMsg)) return 'contact'
      if (hasEmail && /(subscribe|newsletter|updates|waitlist|early)/.test(txt)) return 'newsletter'
      if (hasEmail && /(sign[\s_-]?up|register|get[\s_-]?started|create)/.test(txt)) return 'signup'
      return 'generic'
    } catch (e) { return 'generic' }
  }

  // Auto-lead capture: turn any email a visitor types on the site into an identified
  // CRM contact — no custom forms or code required on the host site. Works via three
  // paths: (1) native form submit, (2) blur/change on any email field (covers AJAX/SPA
  // forms that never fire a native submit), (3) an `email` URL param (magic-link /
  // confirmation redirects). De-duped persistently so we identify each email once.
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
  // Mirrors lib/enrichment/providers.ts:FREE_MX (a copy — this file ships to browsers).
  var FREE_MX = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|proton|protonmail|pm|aol|gmx|mail|zoho|yandex|qq|163|126|hey|fastmail|tutanota|hushmail|duck|simplelogin|anonaddy|addy|mozmail)\./i
  function companyDomain(email) {
    try {
      var d = String(email).split('@')[1]
      if (!d || FREE_MX.test(d + '.')) return null
      return d.toLowerCase()
    } catch (e) { return null }
  }
  // Persistent per-visitor dedupe of identified emails.
  var identSent = {}
  try {
    var st = JSON.parse(localStorage.getItem('mcph_ident') || '{}')
    if (st && typeof st === 'object') identSent = st
  } catch (e) {}
  // Bounded: a shared/kiosk browser used to accumulate every address ever typed, forever.
  function boundKeys(obj, max) {
    var ks = []
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) ks.push(k)
    if (ks.length <= max) return obj
    var out = {}
    for (var i = ks.length - max; i < ks.length; i++) out[ks[i]] = obj[ks[i]]
    return out
  }
  function markIdent(email) {
    identSent[email] = 1
    identSent = boundKeys(identSent, 50)
    try { localStorage.setItem('mcph_ident', JSON.stringify(identSent)) } catch (e) {}
  }
  function findFormEmail(f) {
    try {
      var els = f.elements || []
      for (var i = 0; i < els.length; i++) {
        var el = els[i]
        if (!el || !el.value) continue
        var isEmail = el.type === 'email' || /email|e-mail/i.test((el.name || '') + ' ' + (el.id || ''))
        if (isEmail && EMAIL_RE.test(el.value)) return el.value.trim()
      }
    } catch (e) {}
    return null
  }
  function fieldByHint(f, re) {
    try {
      var els = f.elements || []
      for (var i = 0; i < els.length; i++) {
        var el = els[i]
        if (el && el.value && re.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute && (el.getAttribute('autocomplete') || '') || ''))) return String(el.value).slice(0, 200)
      }
    } catch (e) {}
    return null
  }
  // Broadened hints so we catch mobile/cell/telephone and first/last name splits.
  var PHONE_HINT = /phone|tel|mobile|cell/i
  // Assemble a full name from a form: prefer first+last, else a single full/name field.
  function nameFromForm(f) {
    try {
      var first = fieldByHint(f, /first[\s_-]?name|fname|given/i)
      var last = fieldByHint(f, /last[\s_-]?name|lname|surname|family/i)
      if (first || last) return ((first || '') + ' ' + (last || '')).trim()
      return fieldByHint(f, /full[\s_-]?name|fullname|your[\s_-]?name|contact[\s_-]?name|\bname\b|name/i)
    } catch (e) { return null }
  }
  // Enrich an ALREADY-identified email with a name/phone learned later (e.g. the email
  // was captured on blur before the visitor filled their name). De-duped per email+field
  // so we send each new field at most once; the backend merges traits (never clobbers).
  var identX = {}
  try {
    var stx = JSON.parse(localStorage.getItem('mcph_ident_x') || '{}')
    if (stx && typeof stx === 'object') identX = stx
  } catch (e) {}
  function enrichIdentified(email, form) {
    if (!email || !form) return
    email = String(email).trim().toLowerCase()
    var have = identX[email] || {}
    var add = {}
    if (form.name && !have.name) add.name = form.name
    if (form.phone && !have.phone) add.phone = form.phone
    if (!add.name && !add.phone) return
    have.name = have.name || !!add.name
    have.phone = have.phone || !!add.phone
    identX[email] = have
    identX = boundKeys(identX, 50)
    try { localStorage.setItem('mcph_ident_x', JSON.stringify(identX)) } catch (e) {}
    var dom = companyDomain(email)
    if (dom) add.company_domain = dom
    add.source = 'enrich'
    api.identify(email, add)
    postFormTwin({
      visitorId: vid,
      mode: 'form',
      lang: (navigator.language || '').slice(0, 10),
      form: { email: email, name: add.name, phone: add.phone, company_domain: dom },
      // Same source + automation signals as the identify beacon, like identifyEmail's
      // twin — without them the server labels an enrichment as a fresh form fill.
      source: 'enrich',
      bot_signals: hasKeys(BOTSIG) ? BOTSIG : undefined,
    })
  }
  // The /message "form twin" of an identify: it mints the same contact server-side, so
  // it must obey the SAME consent gate as the identify beacon. Before this it was a
  // bare fetch — under split or gated consent an email left the browser while consent
  // was still pending or already denied (audited 2026-09-05). pending → held in memory
  // and sent on Accept; denied → dropped; no consent mode → sent as before.
  var twinQueue = []
  function postFormTwin(payload) {
    if (requireConsent && consentState !== 'granted') {
      if (consentState === 'pending' && twinQueue.length < 20) twinQueue.push(payload)
      return
    }
    try {
      fetch(apiBase + '/api/tracker/' + tracker + '/message', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain' }, // safelisted → no CORS preflight (endpoint JSON-parses regardless)
        body: JSON.stringify(payload),
      })
    } catch (e) {}
  }
  function flushFormTwins() {
    var q = twinQueue
    twinQueue = []
    for (var i = 0; i < q.length; i++) postFormTwin(q[i])
  }
  // Identify an email (once), enriching with a derived company domain + any nearby
  // name/phone traits, and register it as a form lead in the owning workspace.
  function identifyEmail(email, form, source) {
    if (!email || !EMAIL_RE.test(email) || identSent[email]) return
    email = email.trim().toLowerCase()
    if (identSent[email]) return
    markIdent(email)
    var dom = companyDomain(email)
    var traits = { source: source || 'form' }
    if (form && form.name) traits.name = form.name
    if (form && form.phone) traits.phone = form.phone
    if (dom) traits.company_domain = dom
    api.identify(email, traits)
    postFormTwin({
      visitorId: vid,
      mode: 'form',
      lang: (navigator.language || '').slice(0, 10),
      form: { email: email, name: form && form.name, phone: form && form.phone, company_domain: dom },
      // The same capture path the beacon reports, so the twin's identify records it too.
      source: source || 'form',
      // Same automation signals the identify beacon sends. Both paths mint a contact,
      // so both must be gateable — otherwise this one silently defeats that gate.
      bot_signals: hasKeys(BOTSIG) ? BOTSIG : undefined,
    })
  }
  // Opt-out for forms that must never mint a CRM contact: careers/job applications,
  // sign-in, internal admin, support triage. Without this, autocapture identifies ANY
  // email field on blur — which on a careers page turns a job applicant into a
  // lead-stage contact, and an identified lead is fire-and-forget enrolled into the
  // outreach engine. Put data-mcph-no-capture on the form (or any ancestor).
  // Pageviews and goals are unaffected; only identification is suppressed.
  function noCapture(el) {
    try {
      return !!(el && el.closest && el.closest('[data-mcph-no-capture]'))
    } catch (e) {
      return false
    }
  }
  // Where autocapture must never run, even without the attribute:
  //  - an INTERNAL path (/dashboard, /onboarding …): an email typed there is the
  //    operator adding a CRM contact or inviting a teammate, not a visitor raising a
  //    hand — it used to be identified as a lead in the site owner's own workspace;
  //  - a sign-IN form (formPurpose 'login'): that person is an existing user, and the
  //    app identifies them itself on auth, so a capture is a second, mislabelled lead.
  function skipCapture(el, f) {
    if (noCapture(el) || isInternal()) return true
    if (f) {
      // Sign-IN only: a password form with no sign-up wording is an existing user. A
      // sign-UP form (password + register/create, or an email-only "get started") is a
      // new account on the customer's site, which IS their lead.
      if (formPurpose(f) === 'login') return true
    }
    return false
  }
  function captureFormLead(f) {
    if (skipCapture(f, f)) return
    var email = findFormEmail(f)
    if (!email) return
    email = email.trim().toLowerCase()
    var form = { name: nameFromForm(f), phone: fieldByHint(f, PHONE_HINT) }
    var wasSent = !!identSent[email]
    identifyEmail(email, form)
    // If the email was already identified earlier (e.g. on blur), the submit may now
    // carry a name/phone we didn't have yet — enrich the existing contact.
    if (wasSent) enrichIdentified(email, form)
  }
  // Capture a valid email the moment a field loses focus / changes (AJAX/SPA forms).
  function captureFieldEmail(el) {
    try {
      if (!el || !el.value) return
      if (skipCapture(el, el.form)) return
      var isEmail = el.type === 'email' || /email|e-mail/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute && (el.getAttribute('autocomplete') || '') || ''))
      if (isEmail && EMAIL_RE.test(el.value)) {
        var f = el.form
        identifyEmail(el.value.trim(), f ? { name: nameFromForm(f), phone: fieldByHint(f, PHONE_HINT) } : null)
      }
    } catch (e) {}
  }

  // The identity of a "page" for pageview dedupe: the path, plus the fragment on
  // hash-routed sites. Query-only changes (filters, ?step=2, a cleaned-up ?utm) are the
  // SAME page — replaceState used to fire a second pageview for them, which both
  // double-counted and stamped a UTM-less duplicate. Pure (params only) for the tests.
  function pvKey(path, hash, useHash) {
    return useHash ? path + '#' + (hash || '').replace(/^#/, '') : path
  }
  var lastKey = null, currentUrl = null
  var copyFired = 0, errFired = 0 // per-page autocapture caps (reset on every SPA pageview)
  function resetPerPage() {
    scrollFired = false // re-arm the scroll-depth goal per page
    copyFired = 0
    errFired = 0
    engReset()
  }
  function pageview() {
    // A prerendered page is not a view until it is shown.
    try {
      if (document.prerendering) {
        if (!pvPrerenderWait) {
          pvPrerenderWait = true
          document.addEventListener('prerenderingchange', function () { pvPrerenderWait = false; pageview() }, { once: true })
        }
        return
      }
    } catch (e) {}
    var key = pvKey(location.pathname, location.hash, hashRouting)
    if (key === lastKey) return
    var spa = lastKey !== null
    if (spa) sendEngagement(currentUrl) // close out the page being left
    lastKey = key
    currentUrl = location.href
    var href = location.href
    var prevTitle = pvTitle
    resetPerPage()
    flush() // opportunistically re-send anything queued while offline
    function emit() {
      if (lastKey !== key) return // navigated on before this view rendered
      seedScroll()
      var pg = {}
      try {
        pg.t = String(document.title || '').slice(0, 200)
        pg.w = window.innerWidth
        pg.h = window.innerHeight
        pg.l = String(navigator.language || '').slice(0, 10)
      } catch (e) {}
      pvTitle = pg.t
      send({ type: 'pageview', url: href, referrer: effectiveReferrer(), pg: pg, metadata: { is_returning: isReturning } })
    }
    if (!spa) return emit()
    // SPA: pushState runs before the router renders; wait 2 frames + up to 1s for the title.
    var raf = window.requestAnimationFrame || function (f) { setTimeout(f, 16) }
    raf(function () {
      raf(function () {
        var waited = 0
        ;(function check() {
          if (document.title !== prevTitle || waited >= 1000) return emit()
          waited += 100
          setTimeout(check, 100)
        })()
      })
    })
  }
  var pvTitle = null, pvPrerenderWait = false

  // Public API for custom goals / revenue / identity. `agentsuite` kept as a back-compat alias.
  var api = {
    // Returns the event id (also dispatched as a `mcph:goal` DOM event) so a site
    // running its own Meta/TikTok pixel can pass the SAME id to fbq()/ttq() and the
    // server-side conversion we forward dedupes against the browser pixel.
    track: function (name, meta) {
      meta = meta || {}
      name = normGoal(name)
      if (!name) return null // empty / reserved name — nothing to record
      var rev = meta.revenue_cents
      // `$acquisition: true` marks a goal that COMPLETES acquisition but fires on an
      // internal path — the account-creation goal, whose OAuth path lands on
      // /onboarding. Without it the goal was flagged internal like the rest of the
      // app, dropped at sessionize, and every Google signup was missing from Leads.
      // It exempts this one beacon only; the key itself is never stored.
      var acq = meta.$acquisition === true
      if (acq) {
        var mm = {}
        for (var ak in meta) if (ak !== '$acquisition' && Object.prototype.hasOwnProperty.call(meta, ak)) mm[ak] = meta[ak]
        meta = mm
      }
      var capped = capMeta(meta)
      if (capped.path == null) capped.path = location.pathname // every goal carries its page
      var eid = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      send({ type: rev != null ? 'revenue' : 'goal', name: name, referrer: effectiveReferrer(), revenueCents: rev, metadata: capped, eid: eid }, acq)
      try {
        if (typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('mcph:goal', { detail: { name: name, eventId: eid, meta: capped } }))
      } catch (e) {}
      return eid
    },
    identify: function (email, traits) {
      if (!email) return
      traits = traits || {}
      // Derive the company domain from a business email so the backend can enrich
      // firmographics without any extra config on the host site.
      if (!traits.company_domain) {
        try {
          var d = String(email).split('@')[1]
          if (d && !FREE_MX.test(d + '.')) traits.company_domain = d.toLowerCase()
        } catch (e) {}
      }
      send({ type: 'identify', email: String(email), metadata: traits, referrer: effectiveReferrer(), url: location.href })
    },
    // The anonymous visitor id — pass into a custom checkout (Stripe metadata
    // `mcph_sid` / `client_reference_id`) or a funnel hidden field to stitch a
    // later conversion back to this visitor's journey.
    getVisitorId: function () {
      return vid
    },
    // { ft, lt } — send with a server-side signup so the contact keeps its channel.
    getAttribution: function () {
      return attForBeacon(false)
    },
    // Split testing was removed (2026-10-30). Pages that still call these keep working:
    // every visitor sees the control, nothing is stamped and nothing is recorded.
    variant: function (key, opts) {
      return (opts && opts.control) || 'control'
    },
    getVariant: function () {
      return null
    },
    // Consent control for data-require-consent sites. 'granted' flushes the queue and
    // starts the deferred recorders (split mode also persists the vid); 'denied' drops
    // queued identifies ('all' mode: the whole queue). persist=false is for a decision
    // the VISITOR never made (our banner's auto-grant): never write a durable consent
    // record for it (GDPR Art. 7(1); see docs/architecture/legal-and-consent.md).
    consent: function (state, persist) {
      var persistChoice = persist !== false
      try {
        if (state === 'granted') {
          consentState = 'granted'
          // persist=false is a JURISDICTION grant: record where, never a choice.
          if (persistChoice) localStorage.setItem('mcph_consent', 'granted')
          else localStorage.setItem(REGION_KEY, 'open')
          // Split mode minted the vid in sessionStorage — promote the SAME value so the
          // pre-consent journey stays stitched across future visits. The touch record
          // moves with it, and the cookie-derived Meta ids are read now that they may be.
          try { if (vid) localStorage.setItem('mcph_vid', vid) } catch (e) {}
          attPromote()
          flush()
          flushFormTwins()
          startDeferredRecording()
          try { harvestIdentity() } catch (e) {} // consent just unlocked the identity layer
        } else if (state === 'denied') {
          consentState = 'denied'
          twinQueue = []
          // stop hm.js on this page
          try { if (window.__mcphHM && window.__mcphHM.stop) window.__mcphHM.stop(); window.__mcphHM = undefined } catch (e) {}
          try { localStorage.removeItem(REGION_KEY) } catch (e) {}
          if (persistChoice) localStorage.setItem('mcph_consent', 'denied')
          if (consentMode === 'split') {
            try {
              var kept = JSON.parse(localStorage.getItem(QK) || '[]').filter(function (b) {
                try { return JSON.parse(b).type !== 'identify' } catch (e2) { return false }
              })
              localStorage.setItem(QK, JSON.stringify(kept))
            } catch (e) {}
          } else {
            try { localStorage.removeItem(QK) } catch (e) {}
          }
        }
      } catch (e) {}
    },
  }
  // Pre-load queue: if the site added a stub (window.mcph.q = [['track', args], …])
  // before this script loaded, replay those queued calls now so nothing is lost.
  var preQueue = null
  try {
    if (window.mcph && window.mcph.q && window.mcph.q.length) preQueue = window.mcph.q.slice()
  } catch (e) {}
  function replayCall(call) {
    try {
      var method = call && call[0]
      var args = call && call[1]
      if (typeof api[method] === 'function') api[method].apply(api, args || [])
    } catch (e) {}
  }
  // The stub's `q.push` keeps working after load: it used to vanish with the stub, so
  // a `mcph.q.push([...])` that ran after the script loaded threw on the host page.
  api.q = { push: function () { for (var qi = 0; qi < arguments.length; qi++) replayCall(arguments[qi]) } }
  window.mcph = api
  window.agentsuite = api
  if (preQueue) preQueue.forEach(replayCall)
  // Re-send any offline-queued beacons the moment connectivity returns.
  try { window.addEventListener('online', flush) } catch (e) {}

  // ---- Autocapture (all guarded; analytics must never break the host page) ----
  var DL = /\.(pdf|zip|dmg|pkg|exe|csv|xlsx?|docx?|pptx?|mp4|mp3|wav|rar|gz|tar|txt)$/i
  if (auto) {
    try {
      document.addEventListener(
        'click',
        function (ev) {
          try {
            var el = ev.target
            // Walk up to the nearest anchor / [data-*goal] / button (max 5 hops).
            var a = null, dg = null, btn = null, hops = 0
            for (var node = el; node && hops < 5; node = node.parentElement, hops++) {
              if (!dg && node.getAttribute && (node.getAttribute('data-mcph-goal') || node.getAttribute('data-goal'))) dg = node
              if (!a && node.tagName === 'A') a = node
              if (!btn && (node.tagName === 'BUTTON' || (node.getAttribute && node.getAttribute('role') === 'button'))) btn = node
            }
            if (dg) {
              var gname = dg.getAttribute('data-mcph-goal') || dg.getAttribute('data-goal')
              if (gname) goal(clamp(gname), { text: clamp((dg.textContent || '').trim()) })
            }
            if (a && a.href) {
              var href = a.href
              // Carry the visitor id into Stripe Payment Links / Checkout via
              // client_reference_id (lands on the Checkout Session) so a later
              // payment stitches back to this visitor's journey — zero config.
              if (autolead && vid && a.host && /(^|\.)stripe\.com$/i.test(a.host)) {
                try {
                  var su = new URL(href)
                  if (!su.searchParams.get('client_reference_id')) {
                    su.searchParams.set('client_reference_id', vid)
                    a.href = su.toString()
                    href = a.href
                  }
                } catch (e) {}
              }
              if (/^mailto:/i.test(href)) {
                goal('email_click', { href: clamp(href) })
              } else if (/^tel:/i.test(href)) {
                goal('tel_click', { href: clamp(href) })
              } else if (DL.test((a.pathname || href).split('?')[0])) {
                var m = (a.pathname || href).split('?')[0].match(DL)
                goal('file_download', { href: clamp(href), ext: m ? m[1].toLowerCase() : '' })
              } else if (a.host && regDomain(a.hostname) !== regDomain(location.hostname) && /^https?:/i.test(href)) {
                goal('outbound_link', { href: clamp(href), host: clamp(a.host), text: clamp((a.textContent || '').trim()) })
              }
            } else if (btn && !dg) {
              // A real button click (not a link / not a tracked data-goal). Only fire
              // when it has a short, meaningful text label — avoids icon/nav noise.
              var bt = (btn.textContent || '').trim()
              if (bt && bt.length <= 40) goal('cta_click', { text: clamp(bt) })
            }
          } catch (e) {}
        },
        true,
      )

      document.addEventListener(
        'submit',
        function (ev) {
          try {
            var f = ev.target
            if (!f || f.tagName !== 'FORM') return
            var purpose = formPurpose(f)
            // A sign-in isn't a lead-gen event: skip the goal for pure login forms
            // (password + no signup markers) — existing users logging in were
            // inflating lead-role form_submit counts. Signup forms still fire.
            if (purpose !== 'login')
              goal('form_submit', {
                id: clamp(f.id || ''),
                name: clamp(f.getAttribute('name') || ''),
                action: clamp(f.action || ''),
                purpose: purpose,
                field_count: (f.elements && f.elements.length) || 0,
              })
            // Auto-capture: if the form has an email field, turn the submitter into
            // an identified CRM lead (opt out with data-autolead="false").
            if (autolead) captureFormLead(f)
          } catch (e) {}
        },
        true,
      )

      // Blur/change on any email field — catches AJAX/SPA forms with no native submit.
      if (autolead) {
        var onField = function (ev) { captureFieldEmail(ev.target) }
        document.addEventListener('blur', onField, true)
        document.addEventListener('change', onField, true)
      }

      // Copy — signals someone grabbed a code snippet / coupon / key.
      document.addEventListener('copy', function () {
        try {
          if (copyFired >= 5) return // cap per page
          copyFired++
          var sel = String(window.getSelection ? window.getSelection() : '').trim()
          if (sel.length < 2) return
          goal('copy', { length: sel.length })
        } catch (e) {}
      }, true)

      // Uncaught JS errors on the page (diagnostic). Capped so a broken page can't flood.
      window.addEventListener('error', function (ev) {
        try {
          var msg = String((ev && ev.message) || 'error')
          // opaque cross-origin + benign RO notices (~40% of js_error)
          if (/^Script error\.?$|ResizeObserver loop/.test(msg)) return
          if (errFired >= 3) return
          errFired++
          goal('js_error', { message: clamp(msg) })
        } catch (e) {}
      })
    } catch (e) {}
  }

  // Email in the URL (magic-link / confirmation redirects, e.g. ?email=a@b.com).
  // Not on internal paths: a dashboard URL carrying ?email= is an operator's filter.
  if (autolead && !isInternal()) {
    try {
      // Search + hash params (email-marketing / magic links often sit in the #fragment).
      var qp = new URLSearchParams(location.search)
      var hp = new URLSearchParams((location.hash || '').replace(/^#/, ''))
      var pick = function (n) { return qp.get(n) || hp.get(n) }
      var qe =
        pick('email') || pick('user_email') || pick('email_address') || pick('contact_email') ||
        pick('e') || pick('em') || pick('mail') || pick('login') || pick('username')
      // Last resort: any param VALUE that is itself a valid email.
      if (!qe) { qp.forEach(function (v) { if (!qe && EMAIL_RE.test(v)) qe = v }) }
      if (qe && EMAIL_RE.test(qe)) {
        // Lift name/phone from the same redirect (magic-link / thank-you pages).
        var qFirst = qp.get('first_name') || qp.get('firstname') || qp.get('fname') || qp.get('given_name')
        var qLast = qp.get('last_name') || qp.get('lastname') || qp.get('lname') || qp.get('family_name')
        var qName = qp.get('name') || qp.get('full_name') || qp.get('fullname')
        if (!qName && (qFirst || qLast)) qName = ((qFirst || '') + ' ' + (qLast || '')).trim()
        var qPhone = qp.get('phone') || qp.get('tel') || qp.get('mobile') || qp.get('phone_number')
        identifyEmail(qe, { name: qName ? qName.slice(0, 200) : null, phone: qPhone ? qPhone.slice(0, 60) : null }, 'url')
      }
    } catch (e) {}
  }

  // Identity harvest (first-party, consent-gated): running same-origin on the host
  // site, we can read identity the site's OTHER tools already collected — turning an
  // anonymous return-visitor into an identified contact for free. Gated on the SAME
  // consent as identify (device read → only when identify is allowed to fire).
  // Opt out with data-harvest="false".
  function harvestAllowed() { return !requireConsent || consentState === 'granted' }
  function firstEmailIn(s) { try { var m = String(s).match(EMAIL_RE); return m ? m[0].trim().toLowerCase() : null } catch (e) { return null } }
  function harvestFromStorage() {
    try {
      var ls = window.localStorage
      for (var i = 0; i < ls.length && i < 300; i++) {
        var k = ls.key(i); if (!k || /^(mcph_|as_vid)/.test(k)) continue
        var val = ''; try { val = ls.getItem(k) || '' } catch (e) { continue }
        if (!val || val.indexOf('@') < 0) continue
        // JSON blobs the tools store (Intercom/Drift/HubSpot user objects) — pull an
        // email out of any depth. Only from JSON so we don't grab a stray support addr.
        if (val.charAt(0) === '{' || val.charAt(0) === '[') {
          var got = null
          try { got = firstEmailIn(JSON.stringify(JSON.parse(val))) } catch (e) {}
          if (got) return got
        }
        // Bare email under an identity-suggestive key (intercom/drift/crisp/hubspot/…).
        if (/e-?mail|user|identity|contact|profile|intercom|drift|crisp|hubspot|marketo|_mkto|pardot|customer/i.test(k)) {
          var m = firstEmailIn(val); if (m) return m
        }
      }
    } catch (e) {}
    return null
  }
  function harvestIdentity() {
    if (!harvest || !harvestAllowed() || isInternal()) return
    try {
      var found = null
      // 1) Prefilled logged-in email input (an authed user's address is often in the DOM).
      var inp = document.querySelector('input[type=email]')
      if (inp && !skipCapture(inp, inp.form) && inp.value && EMAIL_RE.test(inp.value)) found = inp.value.trim().toLowerCase()
      // 2) Explicit identity attributes / meta.
      if (!found) {
        var A = ['[data-user-email]', '[data-email]', '[itemprop="email"]', 'meta[property="og:email"]', 'meta[name="author-email"]']
        for (var i = 0; i < A.length && !found; i++) {
          var el = document.querySelector(A[i]); if (!el) continue
          found = firstEmailIn(el.getAttribute('content') || el.getAttribute('data-user-email') || el.getAttribute('data-email') || el.textContent || '')
        }
      }
      // 3) Same-origin storage the site's other tools already populated.
      if (!found) found = harvestFromStorage()
      if (found && !identSent[found]) identifyEmail(found, null, 'harvest')
    } catch (e) {}
  }
  // Deferred off the critical path: it scans up to 300 storage keys synchronously.
  if (harvest) {
    try {
      var idle = window.requestIdleCallback || function (f) { setTimeout(f, 2000) }
      idle(function () { try { harvestIdentity() } catch (e) {} })
    } catch (e) {}
  }

  // Embedded third-party funnels (Heyflow, Tally, Jotform, …) render inside a
  // cross-origin iframe our DOM listeners can't reach — but many broadcast their
  // submission to the parent window via postMessage. Listen for those and lift out
  // the email. Guarded + deduped (via identifyEmail); we only act on a syntactically
  // valid email that sits under an email-named key or arrives with a submit signal.
  if (autolead) {
    try {
      var scanEmail = function (o, depth) {
        if (o == null || depth > 3) return null
        if (typeof o === 'string') return EMAIL_RE.test(o) ? o.trim() : null
        if (typeof o !== 'object') return null
        for (var k in o) {
          try {
            var v = o[k]
            if (typeof v === 'string' && /e-?mail/i.test(k) && EMAIL_RE.test(v)) return v.trim()
          } catch (e) {}
        }
        for (var k2 in o) {
          try {
            var got = scanEmail(o[k2], depth + 1)
            if (got) return got
          } catch (e) {}
        }
        return null
      }
      // Generic bounded-depth walk: first string value whose KEY matches `re`.
      var scanField = function (o, re, depth) {
        if (o == null || depth > 3 || typeof o !== 'object') return null
        for (var k in o) {
          try {
            var v = o[k]
            if (typeof v === 'string' && v && re.test(k)) return v.trim().slice(0, 200)
          } catch (e) {}
        }
        for (var k2 in o) {
          try {
            var got = scanField(o[k2], re, depth + 1)
            if (got) return got
          } catch (e) {}
        }
        return null
      }
      var nameFromPayload = function (src) {
        var first = scanField(src, /first[\s_-]?name|fname|given/i, 0)
        var last = scanField(src, /last[\s_-]?name|lname|surname|family/i, 0)
        if (first || last) return ((first || '') + ' ' + (last || '')).trim()
        return scanField(src, /full[\s_-]?name|fullname|\bname\b|name/i, 0)
      }
      // Only a message from an iframe that is actually in the document, whose src origin
      // equals the message origin, and whose host is a known form provider (or one the
      // site listed in data-embed-origins) may identify anyone. Without this gate ANY
      // frame on the page — an ad, a chat widget — could post {type:'submitted', email}
      // and mint a CRM contact that the outreach engine would then email.
      var EMBED_HOSTS = /(^|\.)(heyflow\.(com|id|site|app)|tally\.so|jotform\.com|typeform\.com|hsforms\.(com|net)|hubspot\.com|paperform\.co|fillout\.com|formstack\.com|youform\.com)$/i
      var extraEmbedHosts = (s.getAttribute('data-embed-origins') || '')
        .split(',')
        .map(function (h) { return h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') })
        .filter(Boolean)
      function embedOriginOk(ev) {
        try {
          if (!ev.origin || !ev.source) return false
          var host = new URL(ev.origin).hostname.toLowerCase()
          var allowed = EMBED_HOSTS.test(host)
          for (var hi = 0; hi < extraEmbedHosts.length && !allowed; hi++) {
            if (host === extraEmbedHosts[hi] || host.slice(-(extraEmbedHosts[hi].length + 1)) === '.' + extraEmbedHosts[hi]) allowed = true
          }
          if (!allowed) return false
          var frames = document.getElementsByTagName('iframe')
          for (var fi = 0; fi < frames.length; fi++) {
            if (frames[fi].contentWindow !== ev.source) continue
            try { return new URL(frames[fi].src).origin === ev.origin } catch (e) { return false }
          }
          return false
        } catch (e) { return false }
      }
      window.addEventListener(
        'message',
        function (ev) {
          try {
            if (!embedOriginOk(ev)) return
            var d = ev.data
            if (typeof d === 'string') {
              try { d = JSON.parse(d) } catch (e) { return }
            }
            if (!d || typeof d !== 'object') return
            var t = String(d.type || d.event || '')
            var known = /heyflow-submit|form-submit|FormSubmitted|submission-completed|submitted/i.test(t)
            var src = d.fields || (d.payload && d.payload.fields) || d.data || d
            var email = scanEmail(src, 0)
            if (!email) return
            // Reduce noise: require a known submit signal OR an email-named key present.
            if (!known) {
              var probe = ''
              try { probe = JSON.stringify(src).slice(0, 4000) } catch (e) {}
              if (!/e-?mail/i.test(probe)) return
            }
            identifyEmail(email, { name: nameFromPayload(src), phone: scanField(src, PHONE_HINT, 0) }, 'embed')
          } catch (e) {}
        },
        false,
      )
    } catch (e) {}
  }

  // Scroll depth — tracks the max % for the engagement beacon on every scroll, and
  // fires the scroll_90 goal once per pageview. rAF-throttled.
  var scrollFired = false
  var ticking = false
  var onScroll = function () {
    if (ticking) return
    ticking = true
    var raf = window.requestAnimationFrame || function (f) { setTimeout(f, 16) }
    raf(function () {
      ticking = false
      try {
        var pct = scrollPct()
        if (pct > maxScroll) maxScroll = pct
        if (auto && !scrollFired && userScrolled && pct >= 90) {
          scrollFired = true
          goal('scroll_90', { path: location.pathname })
        }
      } catch (e) {}
    })
  }
  try {
    window.addEventListener('scroll', onScroll, { passive: true })
  } catch (e) {}

  // Rage clicks (opt-in): 3+ clicks within ~700ms in a ~30px radius.
  if (auto && rage) {
    var clicks = []
    document.addEventListener(
      'click',
      function (ev) {
        try {
          var now = Date.now()
          // Not rage: keyboard activation (detail 0), editing, text selection.
          if (Number(ev.detail) === 0) return
          var tg = ev.target, tn = tg && tg.tagName ? String(tg.tagName).toLowerCase() : ''
          if (tn === 'input' || tn === 'textarea' || tn === 'select' || (tg && tg.isContentEditable)) return
          try { if (String(window.getSelection ? window.getSelection() : '').length) return } catch (e) {}
          clicks.push({ t: now, x: ev.clientX, y: ev.clientY })
          clicks = clicks.filter(function (c) { return now - c.t < 700 })
          if (clicks.length >= 3) {
            var a = clicks[0], b = clicks[clicks.length - 1]
            if (Math.abs(a.x - b.x) < 30 && Math.abs(a.y - b.y) < 30) {
              clicks = []
              goal('rage_click', { path: location.pathname, x: ev.clientX, y: ev.clientY })
            }
          }
        } catch (e) {}
      },
      true,
    )
  }

  // Initial pageview + SPA route change hooks. pushState / replaceState / popstate /
  // hashchange all funnel into pageview(), which only counts a CHANGED page key — so a
  // replaceState that merely rewrites the query string is silent. bfcache restores
  // (pageshow with persisted) count as a new view of the page; pagehide and tab-hide
  // close out the engagement of the current page. Never unload/beforeunload: both
  // break the back/forward cache and fire less reliably than pagehide.
  if (autoPageviews) {
    pageview()
    var push = history.pushState
    history.pushState = function () {
      push.apply(this, arguments)
      pageview()
    }
    var replace = history.replaceState
    history.replaceState = function () {
      replace.apply(this, arguments)
      pageview()
    }
    window.addEventListener('popstate', pageview)
    if (hashRouting) window.addEventListener('hashchange', pageview)
    try {
      window.addEventListener('pageshow', function (ev) {
        if (ev && ev.persisted) { lastKey = null; pageview() }
      })
    } catch (e) {}
  } else {
    engReset()
    seedScroll()
  }
  try {
    window.addEventListener('pagehide', function () {
      sendEngagement(currentUrl)
      flush()
    })
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { sendEngagement(currentUrl); flush() }
      else engResume()
    })
  } catch (e) {}
  // Cross-domain linker: decorate outbound links to the listed sibling domains.
  if (linkDomains.length) {
    try {
      document.addEventListener(
        'click',
        function (ev) {
          try {
            var n = ev.target, la = null, lh = 0
            for (; n && lh < 5 && !la; n = n.parentElement, lh++) if (n.tagName === 'A' || n.tagName === 'a') la = n
            if (!la || !la.href || !la.host || !/^https?:/i.test(la.href)) return
            var rd = regDomain(la.hostname)
            if (rd === regDomain(location.hostname) || linkDomains.indexOf(rd) < 0) return
            var lu = new URL(la.href)
            lu.searchParams.set('_mcph', vid + '.' + Date.now().toString(36))
            la.href = lu.toString()
          } catch (e) {}
        },
        true,
      )
    } catch (e) {}
  }

  // ---- Heatmaps & session recording (Microsoft Clarity / Hotjar) ----
  // Recording is heavy + privacy-sensitive, so we lean on a proven recorder rather
  // than shipping one in the tracker. Provide a project id via data-clarity="xxxx"
  // (free, unlimited) and/or data-hotjar="123456" on the script tag and we load it
  // once, tied to the same install so recordings line up with the user journeys.
  function loadHeatmaps(clarityId, hotjarId) {
    try {
      clarityId = clarityId || s.getAttribute('data-clarity')
      if (clarityId && !window.clarity) {
        ;(function (c, l, a, r, i, t, y) {
          c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments) }
          t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i
          y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y)
        })(window, document, 'clarity', 'script', clarityId)
      }
      hotjarId = hotjarId || s.getAttribute('data-hotjar')
      if (hotjarId && !window.hj) {
        ;(function (h, o, t, j, a, r) {
          h.hj = h.hj || function () { (h.hj.q = h.hj.q || []).push(arguments) }
          h._hjSettings = { hjid: Number(hotjarId), hjsv: 6 }
          a = o.getElementsByTagName('head')[0]
          r = o.createElement('script'); r.async = 1
          r.src = t + h._hjSettings.hjid + j + h._hjSettings.hjsv
          a.appendChild(r)
        })(window, document, 'https://static.hotjar.com/c/hotjar-', '.js?sv=')
      }
    } catch (e) {}
  }
  // Attribute-based load (immediate); config-driven ids injected below. Gated modes
  // ('all'/'split') hold ALL recording layers until consent is granted — recording is
  // exactly the privacy-sensitive layer the consent ask covers (pre-2026-08 this loaded
  // unconditionally, so consent-gating sites recorded decliners).
  if (!consentBlocksRecording()) loadHeatmaps()

  // In-house heatmaps + session replay: hand off to hm.js (heavier, lazy-loaded)
  // only when the workspace opted into mode:'inhouse' and this session is sampled in.
  // Skips our own dashboard traffic (internal). Mints a per-tab replay session id.
  function loadInhouseHeatmaps(hm) {
    try {
      if (isInternal()) return
      // Headless/automation sessions pollute click maps + generate junk replays. Skip
      // capture entirely (the server re-checks bot_signals as the authoritative gate).
      if (botsigAutomated()) return
      if (window.__mcphHM) return
      var rsid
      try {
        rsid = sessionStorage.getItem('mcph_rsid')
        // A recording ends after 30 idle minutes (hm.js stamps mcph_rlast per chunk).
        var rlast = parseInt(sessionStorage.getItem('mcph_rlast') || '', 10)
        if (rsid && rlast > 0 && Date.now() - rlast > 30 * 60 * 1000) {
          rsid = null
          sessionStorage.removeItem('mcph_rseq')
        }
        if (!rsid) { rsid = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); sessionStorage.setItem('mcph_rsid', rsid) }
      } catch (e) { rsid = 'r' + Math.random().toString(36).slice(2, 10) }
      // isInternal is handed over so hm.js re-checks the internal-path list PER EVENT
      // (the once-at-load check above only covers sessions that START on an app page).
      window.__mcphHM = { tracker: tracker, apiBase: apiBase, vid: vid, sid: rsid, cfg: hm, botsig: hasKeys(BOTSIG) ? BOTSIG : null, isInternal: isInternal }
      var h = document.createElement('script')
      h.async = true
      h.src = apiBase + '/hm.js'
      ;(document.head || document.documentElement).appendChild(h)
    } catch (e) {}
  }

  // Routes a fetched heatmaps config to the right loader (consent already checked by
  // callers). Split out so a post-banner mcph.consent('granted') can start recording
  // without a page reload.
  function applyHeatmapsConfig(hm) {
    if (hm.mode === 'inhouse') {
      if (passesSample(vid, hm.sample_rate)) loadInhouseHeatmaps(hm)
    } else if (hm.mode === 'external' || hm.clarity_id || hm.hotjar_id) {
      loadHeatmaps(hm.clarity_id, hm.hotjar_id)
    }
  }
  var hmDeferred = null // heatmaps config stashed while consent is pending/denied
  function startDeferredRecording() {
    if (consentBlocksRecording()) return
    try { loadHeatmaps() } catch (e) {} // attribute-based ids held back at init
    if (hmDeferred) {
      var hd = hmDeferred
      hmDeferred = null
      try { applyHeatmapsConfig(hd) } catch (e) {}
    }
  }

  // ---- Config fetch: heatmaps (always) + support widget (lazy) ----
  // Always fetch the per-tracker config so config-driven heatmaps (Clarity/Hotjar)
  // load even when the support widget is off. Then, if the widget is enabled (or an
  // inline [data-mcph-form] exists), load the heavier widget.js. Guarded — never
  // blocks the page.
  try {
    var wlang = (navigator.language || '').slice(0, 10)
    // ---- WebMCP -------------------------------------------------------
    // Chrome's trial runs to 2027-03-30 (M162) and the API moved from navigator.modelContext
    // to document.modelContext on 2026-07-21 (Chrome 150 deprecated the old
    // location while the trial still ships it), so BOTH are read.
    //
    // Without the origin-trial token document.modelContext is undefined and every
    // registerTool() is a silent no-op — so a missing token must look like
    // "not enabled", never like a failure.
    var webmcpDone = false
    function setupWebmcp(w) {
      if (webmcpDone || !webmcpOn || !w || !w.token || !w.tools || !w.tools.length) return
      webmcpDone = true
      try {
        // Third-party origin trials are delivered by the SCRIPT's origin
        // injecting the meta tag — a third-party token cannot be served in the
        // page's own markup or an HTTP header.
        var m = document.createElement('meta')
        m.httpEquiv = 'origin-trial'
        m.content = w.token
        ;(document.head || document.documentElement).appendChild(m)
      } catch (e) { return }
      // The meta tag is picked up synchronously, but be defensive: a browser
      // with no support leaves both undefined and we simply do nothing.
      var mc = document.modelContext || navigator.modelContext
      if (!mc || typeof mc.registerTool !== 'function') return
      var askName = w.tools[0] && w.tools[0].name
      var specs = {}
      for (var i = 0; i < w.tools.length; i++) { specs[w.tools[i].name] = w.tools[i]; registerOne(w.tools[i]) }
      // The only same-origin paths a declared `post` action may call. Mirrors
      // lib/webmcp/tools.ts WEBMCP_POST_PATHS (tools.test.ts pins both copies), so a
      // tampered config still cannot aim an agent's call anywhere else.
      var WEBMCP_POST_PATHS = ['/api/v1/signup/start', '/api/v1/signup/verify', '/api/tools/ai-readiness-grader']

      function registerOne(spec) {
        try {
          mc.registerTool({
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema,
            execute: function (args) { return run(spec.name, args || {}) },
          })
        } catch (e) {}
      }

      function done(name, text) {
        // Every call is measured. A GOAL, not a new event type: goals already
        // flow through the rollups and the Tinybird pipes, so agent tool calls
        // land in the Goals tab with no schema change anywhere.
        try { goal('agent_tool_call', { tool: name, path: location.pathname }) } catch (e) {}
        return { content: [{ type: 'text', text: String(text) }] }
      }

      function runAction(name, a, args) {
        if (a.kind === 'text') return Promise.resolve(done(name, a.text))
        if (a.kind !== 'post' || WEBMCP_POST_PATHS.indexOf(a.path) === -1) return Promise.resolve(done(name, 'Unknown tool.'))
        var body = {}
        var f = a.fields || []
        for (var k = 0; k < f.length; k++) if (args[f[k]] != null && args[f[k]] !== '') body[f[k]] = String(args[f[k]]).slice(0, 500)
        return fetch(apiBase + a.path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.text() })
          .then(function (t) { return done(name, String(t || '').slice(0, 6000) || 'No answer.') })
          .catch(function () { return done(name, 'Could not reach the site just now.') })
      }

      function run(name, args) {
        var sp = specs[name]
        if (sp && sp.action) return runAction(name, sp.action, args || {})
        if (name === 'book_a_meeting') {
          return Promise.resolve(done(name, 'Book a time here: ' + w.bookingUrl))
        }
        if (name !== askName) return Promise.resolve(done(name, 'Unknown tool.'))
        var q = String((args && args.question) || '').slice(0, 1000)
        if (!q) return Promise.resolve(done(name, 'Ask a question to get an answer.'))
        // The same endpoint the support widget uses — already sealed to a
        // two-tool allow-list with no BI or CRM reach, so this adds no new
        // trust boundary.
        return fetch(apiBase + '/api/tracker/' + tracker + '/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitorId: vid, message: q, source: 'webmcp' }),
        })
          .then(function (r) { return r.ok ? r.json() : null })
          .then(function (j) {
            return done(name, (j && (j.reply || j.message)) || 'No answer available right now.')
          })
          .catch(function () { return done(name, 'Could not reach the site just now.') })
      }
    }

    // Cached per tab for 10 minutes — the config is per tracker, not per page, and an
    // SPA session used to refetch it on every full load.
    var CFG_KEY = 'mcph_cfg:' + tracker + ':' + wlang
    var cfgPromise = null
    try {
      var cached = JSON.parse(sessionStorage.getItem(CFG_KEY) || 'null')
      if (cached && cached.t && Date.now() - cached.t < 600000 && cached.cfg) cfgPromise = Promise.resolve(cached.cfg)
    } catch (e) {}
    if (!cfgPromise) {
      cfgPromise = fetch(scriptBase + '/api/tracker/' + tracker + '/config' + (wlang ? '?lang=' + encodeURIComponent(wlang) : ''))
        .then(function (r) { return r.json() })
        .then(function (cfg) {
          try { if (cfg) sessionStorage.setItem(CFG_KEY, JSON.stringify({ t: Date.now(), cfg: cfg })) } catch (e) {}
          return cfg
        })
    }
    cfgPromise
      .then(function (cfg) {
        if (!cfg) return
        // First, so heatmaps / widget / every later beacon use the verified subdomain.
        if (cfg.trackingHost) useTrackingHost(cfg.trackingHost, true)
        else if ('trackingHost' in cfg) forgetTrackingHost()
        setupWebmcp(cfg.webmcp)
        if (cfg.heatmaps) {
          // Gated modes: stash the config until consent is granted (mcph.consent
          // triggers startDeferredRecording) instead of loading recorders now.
          if (consentBlocksRecording()) hmDeferred = cfg.heatmaps
          else applyHeatmapsConfig(cfg.heatmaps)
        }
        var hasInline = !!document.querySelector('[data-mcph-form]')
        if (!widgetOn || (!cfg.enabled && !hasInline)) return
        // Never load the support widget on a data-internal-paths prefix (the site's
        // own signed-in app, e.g. /dashboard): an operator does not need the public
        // chat bubble floating over their product. Path prefixes only — a site-wide
        // data-internal="1" (a staging flag) deliberately keeps its widget.
        for (var wi = 0; wi < internalPaths.length; wi++) {
          if (location.pathname.indexOf(internalPaths[wi]) === 0) return
        }
        window.__mcphWidget = {
          tracker: tracker,
          apiBase: apiBase,
          vid: vid,
          enabled: !!cfg.enabled,
          config: cfg.config || {},
          strings: cfg.strings || {},
          lang: cfg.lang || 'en',
        }
        var w = document.createElement('script')
        w.async = true
        w.src = apiBase + '/widget.js'
        ;(document.head || document.documentElement).appendChild(w)
      })
      .catch(function () {})
  } catch (e) {}
})()
