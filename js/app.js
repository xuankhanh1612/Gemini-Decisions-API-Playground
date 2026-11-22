// The Decisions API Playground UI (Preact + htm, no build step).
'use strict';
(function () {
  const {html, render, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback} = window.htmPreact;
  const DP = window.DP;
  const {TYPES, TYPE_ORDER, LIMITS} = DP;
  LIMITS.fileBytes = 20 * 1024 * 1024;
  LIMITS.requestBytes = 20 * 1024 * 1024;

  const DOCS_URL = 'https://aistudio.google.com/docs/decisions-api';
  /** The Decisions API model ID. */
  const API_MODEL = 'gemini-decision-1';
  const STORAGE = {theme: 'dp.theme', draft: 'dp.draft', settings: 'dp.settings', apiKey: 'dp.apiKey'};
  const GET_KEY_URL = 'https://aistudio.google.com/apikey';

  /**
   * Set by an AI Studio applet build (js/applet-config.js): the page calls the
   * Decisions API itself, and AI Studio supplies the API key.
   */
  const CONFIG = window.DP_CONFIG || {};
  const DIRECT = !!CONFIG.direct;
  const IN_AISTUDIO = Boolean(
    window.self !== window.top &&
      window.aistudio &&
      typeof window.aistudio.openSelectKey === 'function' &&
      typeof window.aistudio.hasSelectedApiKey === 'function',
  );
  const DIRECT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
  const DIRECT_MODELS = ['gemini-decision-1'];

  function cleanApiKey(raw) {
    return String(raw || '')
      .trim()
      .replace(/^['"]+|['"]+$/g, '')
      .trim();
  }

  /**
   * Sends a POST directly from the browser without going through AI Studio's
   * _aistudio-iframe.js window.fetch proxy (which rewrites x-goog-api-key).
   */
  async function directPostJson(url, headers, body, signal) {
    const fn =
      CONFIG.nativeFetch ||
      (typeof window.fetch === 'function' && Function.prototype.toString.call(window.fetch).includes('[native code]')
        ? window.fetch.bind(window)
        : null);
    if (fn) {
      const r = await fn(url, {method: 'POST', headers, body, signal});
      const payload = await r.json().catch(() => ({}));
      return {ok: r.ok, status: r.status, payload};
    }
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      const onAbort = () => xhr.abort();
      if (signal) signal.addEventListener('abort', onAbort, {once: true});
      const cleanup = () => signal && signal.removeEventListener('abort', onAbort);
      xhr.onload = () => {
        cleanup();
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || '{}');
        } catch (e) {
          payload = {};
        }
        resolve({ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, payload});
      };
      xhr.onerror = () => {
        cleanup();
        reject(new TypeError('Network request failed'));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      xhr.send(body);
    });
  }

  /** Calls the Decisions API from the page with a key. Returns {ok, status, payload}. */
  async function callDirect(request, signal, apiKey) {
    const key = cleanApiKey(apiKey);
    const useHostProxy = IN_AISTUDIO && !key;
    let last = {ok: false, status: 0, payload: {}};
    for (const model of DIRECT_MODELS) {
      const started = performance.now();
      let r;
      if (useHostProxy) {
        const res = await window.fetch(DIRECT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': window.GEMINI_API_KEY || 'GEMINI_API_KEY',
          },
          body: JSON.stringify({...request, model}),
          signal,
        });
        const payload = await res.json().catch(() => ({}));
        r = {ok: res.ok, status: res.status, payload};
      } else {
        r = await directPostJson(
          DIRECT_ENDPOINT,
          {'Content-Type': 'application/json', 'x-goog-api-key': key},
          JSON.stringify({...request, model}),
          signal,
        );
      }
      const payload = r.payload || {};
      if (r.ok && payload.answers) {
        if (typeof payload.latency_ms !== 'number') payload.latency_ms = Math.round(performance.now() - started);
        return {ok: true, status: r.status, payload};
      }
      last = {ok: false, status: r.status, payload};
      if (r.status !== 404) break; // Only an unknown model name is worth another try.
    }
    return last;
  }

  /** Verifies that an API key can call the Decisions API. */
  async function verifyApiKey(apiKey, signal) {
    const r = await callDirect(
      {
        input: 'ok',
        questions: {ok: {type: 'noul', instructions: 'Is this text non-empty?'}},
      },
      signal,
      apiKey,
    );
    if (r.ok || r.status === 429) return {ok: true};
    const message = (r.payload && r.payload.error && r.payload.error.message) || `The server returned HTTP ${r.status}.`;
    const badKey = r.status === 400 && /api key/i.test(message);
    if (badKey) {
      return {ok: false, error: `That API key didn't work. (${message})`};
    }
    if ([401, 403, 404].includes(r.status)) {
      return {
        ok: false,
        error: `This API key couldn't access the Decisions API. Check that your key is valid and try again. (${message})`,
      };
    }
    return {ok: false, error: message};
  }

  async function callBackend(body, signal) {
    const r = await fetch('api/decisions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Requested-With': 'decision-playground'},
      credentials: 'same-origin',
      body,
      signal,
    });
    const payload = await r.json().catch(() => ({}));
    return {ok: r.ok && !!payload.answers, status: r.status, payload};
  }

  /** Shown until /api/health answers, and when there is no backend at all. */
  const FALLBACK_MODELS = [
    {
      id: 'gemini-decision-1',
      label: CONFIG.modelLabel || 'Gemini Decisions',
      family: 'decisions',
      summary: 'Scores every option in one forward pass. Calibrated probabilities, no output tokens.',
      default: true,
    },
  ];

  // Three solid bars, as in the Decisions mocks; lucide's chart icon has axes.
  DP.ICONS['score-bars'] = [
    ['rect', {x: '4', y: '11', width: '4', height: '9', rx: '1.2', fill: 'currentColor', stroke: 'none'}],
    ['rect', {x: '10', y: '4', width: '4', height: '16', rx: '1.2', fill: 'currentColor', stroke: 'none'}],
    ['rect', {x: '16', y: '8', width: '4', height: '12', rx: '1.2', fill: 'currentColor', stroke: 'none'}],
  ];
  DP.ICONS.link = [
    ['path', {d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'}],
    ['path', {d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'}],
  ];
  TYPES.score.icon = 'score-bars';

  // ------------------------------------------------------------- Helpers

  function cx(...names) {
    return names.filter(Boolean).join(' ');
  }

  /** Formats `backtick` spans as inline <code> chips. */
  function formatInlineCode(text) {
    if (!text || !text.includes('`')) return text;
    const parts = String(text).split(/(`[^`\n]+`)/g);
    return parts.map((part, i) =>
      part.length >= 2 && part.startsWith('`') && part.endsWith('`')
        ? html`<code key=${i} class="inline-code">${part.slice(1, -1)}</code>`
        : part,
    );
  }

  function readStorage(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  /** Returns whether the value was saved. */
  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Storage can be full or blocked (e.g. sandboxed hosting). Not fatal.
      return false;
    }
  }

  function routeFromHash() {
    return window.location.hash.startsWith('#/playground') ? 'work' : 'home';
  }

  /** The signatures a run is compared against to tell when it's out of date. */
  function signatures(draft, modelId) {
    const q = {};
    for (const question of draft.questions) {
      q[question.uid] = question.key.trim() + DP.stableStringify(DP.questionPayload(question));
    }
    const resolution = DP.mediaResolutionFor(draft.media, draft.mediaResolution) || '';
    return {
      input: draft.text + '\u0000' + draft.media.map((m) => m.id).join(',') + '\u0000' + resolution,
      model: modelId,
      q,
    };
  }

  function draftFromExample(example) {
    return {
      title: example.title,
      exampleId: example.id,
      text: example.input,
      media: (example.media || []).map((m) =>
        m.text !== undefined
          ? {id: DP.uid('m'), name: m.name, mimeType: m.mime_type, size: m.text.length, kind: 'text', text: m.text}
          : {
              id: DP.uid('m'),
              name: m.name,
              mimeType: m.mime_type,
              size: null,
              kind: 'binary',
              data: null,
              src: m.src,
              previewUrl: /^(image|video|audio)\//.test(m.mime_type) ? m.src : null,
            },
      ),
      questions: example.questions.map((q) => DP.makeQuestion(q)),
    };
  }

  /** Reads an example's sample files so they can be sent. */
  async function loadExampleMedia(media) {
    return Promise.all(
      media.map(async (m) => {
        if (m.kind !== 'binary' || m.data) return m;
        try {
          const r = await fetch(m.src, {credentials: 'same-origin'});
          if (!r.ok) return m;
          const blob = await r.blob();
          return {...m, size: blob.size, data: await readAsBase64(blob)};
        } catch (e) {
          return m; // No backend can read it either; recordings still replay.
        }
      }),
    );
  }

  /**
   * Media that can be saved: text attachments, URL attachments, and sample files by URL.
   * Uploaded binary files are left out; they can be large and are easy to re-add.
   */
  function persistableMedia(media) {
    return (media || [])
      .filter((m) => m.kind === 'text' || (m.kind === 'url' && m.uri) || m.src)
      .map((m) =>
        m.kind === 'text'
          ? {id: m.id, kind: 'text', name: m.name, mimeType: m.mimeType, size: m.size, text: m.text}
          : m.kind === 'url'
            ? {
                id: m.id,
                kind: 'url',
                name: m.name,
                mimeType: m.mimeType,
                size: null,
                uri: m.uri,
                previewUrl: /^(image|video|audio)\//.test(m.mimeType) || m.mimeType === 'application/pdf' ? m.uri : null,
              }
            : {
                id: m.id,
                kind: 'binary',
                name: m.name,
                mimeType: m.mimeType,
                size: m.size,
                data: null,
                src: m.src,
                previewUrl: /^(image|video|audio)\//.test(m.mimeType) ? m.src : null,
              },
      );
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsText(file);
    });
  }

  const TEXT_EXTENSIONS = /\.(json|txt|md|csv|tsv|log|xml|ya?ml)$/i;
  const EXT_MIME = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mpeg: 'video/mpeg',
    mpg: 'video/mpeg',
    '3gp': 'video/3gpp',
    flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    flac: 'audio/flac',
    opus: 'audio/opus',
    weba: 'audio/webm',
    pdf: 'application/pdf',
    json: 'application/json',
  };

  function inferMimeType(name, fallbackType) {
    const cleanType = String(fallbackType || '').trim();
    if (cleanType && cleanType !== 'application/octet-stream') return cleanType;
    const cleanName = String(name || '').split(/[?#]/)[0];
    const dot = cleanName.lastIndexOf('.');
    if (dot !== -1) {
      const ext = cleanName.slice(dot + 1).toLowerCase();
      if (EXT_MIME[ext]) return EXT_MIME[ext];
    }
    return cleanType || 'text/plain';
  }

  /** 'text' files are sent as text parts; 'binary' ones as base64 media. */
  function fileKind(file) {
    const type = inferMimeType(file.name, file.type);
    if (/^(image|audio|video)\//.test(type) || type === 'application/pdf') return 'binary';
    if (type.startsWith('text/') || type === 'application/json' || TEXT_EXTENSIONS.test(file.name)) return 'text';
    return null;
  }

  function attachmentIcon(m) {
    if (m.kind === 'text') return m.mimeType === 'application/json' || /\.json$/i.test(m.name) ? 'braces' : 'file-text';
    if (m.mimeType.startsWith('audio/')) return 'audio-lines';
    if (m.mimeType.startsWith('video/')) return 'video';
    if (m.mimeType.startsWith('image/')) return 'image';
    return 'file-text';
  }

  function attachmentLabel(m) {
    if (m.kind === 'text') return /\.json$/i.test(m.name) || m.mimeType === 'application/json' ? 'JSON' : 'Text';
    if (m.mimeType === 'application/pdf') return 'PDF';
    const [kind] = m.mimeType.split('/');
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }

  // ---------------------------------------------------------- Primitives

  function Icon({name, size = 18, stroke = 1.8, className, label}) {
    const children = (DP.ICONS[name] || []).map(([tag, attrs], i) => window.htmPreact.h(tag, {...attrs, key: i}));
    return html`<svg
      class=${cx('icon', className)}
      width=${size}
      height=${size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width=${stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      role=${label ? 'img' : undefined}
      aria-label=${label}
      aria-hidden=${label ? undefined : 'true'}
    >${children}</svg>`;
  }

  function TypeTile({type, small}) {
    const meta = TYPES[type];
    return html`<span class=${cx('tile tinted', small && 'tile-sm', `tone-${meta.tone}`)}>
      <${Icon} name=${meta.icon} size=${small ? 17 : 20} />
    </span>`;
  }

  /** A textarea that grows with its content. */
  function AutoTextarea(props) {
    const ref = useRef(null);
    const {minRows = 2, className, ...rest} = props;
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + 2}px`;
    }, [props.value]);
    return html`<textarea ref=${ref} rows=${minRows} class=${cx('textarea', className)} ...${rest}></textarea>`;
  }

  /** Closes on outside press and Escape. */
  function useDismiss(open, onClose, ref) {
    useEffect(() => {
      if (!open) return undefined;
      const onDown = (e) => {
        if (ref.current && !ref.current.contains(e.target)) onClose();
      };
      const onKey = (e) => {
        if (e.key === 'Escape') onClose();
      };
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onDown);
        document.removeEventListener('keydown', onKey);
      };
    }, [open, onClose, ref]);
  }

  function Dialog({title, description, onClose, wide, children}) {
    const panel = useRef(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
      const previous = document.activeElement;
      if (panel.current && !panel.current.contains(document.activeElement)) {
        panel.current.focus();
      }
      const onKey = (e) => {
        if (e.key === 'Escape') {
          const overlays = document.querySelectorAll('.overlay');
          if (!panel.current || !overlays.length || overlays[overlays.length - 1].contains(panel.current)) {
            closeRef.current();
          }
          return;
        }
        if (e.key !== 'Tab' || !panel.current) return;
        // Keep focus inside the dialog.
        const items = [
          ...panel.current.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex="0"]',
          ),
        ];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      };
      document.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
      return () => {
        document.removeEventListener('keydown', onKey);
        document.body.style.overflow = document.querySelector('.overlay') ? 'hidden' : '';
        if (previous && previous.focus) previous.focus();
      };
    }, []);
    return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
      <div class=${cx('dialog', wide && 'dialog-wide')} role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1" ref=${panel}>
        <h2 id="dialog-title">${title}</h2>
        ${description && html`<p class="desc">${description}</p>`}
        ${children}
        <button class="dialog-close" aria-label="Close" onClick=${onClose}>
          <${Icon} name="x" size=${16} />
        </button>
      </div>
    </div>`;
  }

  /** A code view with tabs and Copy, after the AI Studio snippet block. */
  // A port of the workshop's ais-snippet-block: language tabs along the top,
  // Copy at the right of the same row, then the code.
  function CodeBlock({tabs, active, onTab, code, language, empty, emptyAction, onCopy}) {
    const tokens = useMemo(() => (code ? DP.highlight(code, language) : []), [code, language]);
    const [copied, setCopied] = useState(false);
    useEffect(() => {
      if (!copied) return undefined;
      const t = setTimeout(() => setCopied(false), 1500);
      return () => clearTimeout(t);
    }, [copied]);
    return html`<div class="code-block">
      <div class="code-head">
        <div class="code-tabs" role="tablist">
          ${tabs.map(
            (t) => html`<button
              class="quiet"
              role="tab"
              aria-selected=${t.id === active ? 'true' : 'false'}
              onClick=${() => onTab(t.id)}
            >
              ${t.label}
            </button>`,
          )}
        </div>
        ${onCopy &&
        code &&
        html`<button
          class="quiet code-copy"
          onClick=${() => {
            onCopy(code);
            setCopied(true);
          }}
        >
          <${Icon} name=${copied ? 'check' : 'copy'} size=${14} /> ${copied ? 'Copied' : 'Copy'}
        </button>`}
      </div>
      ${code
        ? html`<pre class="code-body" tabindex="0">${tokens.map(([cls, text], i) =>
            cls ? html`<span key=${i} class=${cls}>${text}</span>` : text,
          )}</pre>`
        : html`<div class=${cx('code-body hint', emptyAction && 'code-empty-row')}>
            <span>${empty}</span>
            ${emptyAction}
          </div>`}
    </div>`;
  }


  // -------------------------------------------------------- Answer charts

  function Bars({rows, tone, wide}) {
    return html`<div class=${cx('bars', wide && 'wide', `tone-${tone}`)}>
      ${rows.map((row) => {
        const width = Math.max(0, Math.min(1, row.probability || 0)) * 100;
        return html`
          <span key=${row.key + 'l'} class=${cx('bar-label', row.selected && 'is-selected')} title=${row.label}>
            ${row.label}
          </span>
          <span key=${row.key + 'b'} class="bar">
            <span class=${cx('bar-fill', row.selected && 'is-selected')} style=${{width: `${width}%`}}></span>
          </span>
          <span key=${row.key + 'v'} class=${cx('bar-value', row.selected && 'is-selected')}>
            ${DP.formatProbability(row.probability)}
          </span>
        `;
      })}
    </div>`;
  }

  /** The zero state's small scale: short level names under the track. */
  function MiniScale({rows, score, tone}) {
    const n = rows.length;
    const at = (i) => (n > 1 ? (i / (n - 1)) * 100 : 50);
    const dot = typeof score === 'number' && n > 1 ? Math.max(0, Math.min(100, (score / (n - 1)) * 100)) : null;
    return html`<div class=${cx('scale', `tone-${tone}`)}>
      <div class="scale-track">
        ${rows.map((row, i) => html`<span key=${row.key} class="scale-tick" style=${{left: `${at(i)}%`}}></span>`)}
        ${dot !== null && html`<span class="scale-dot" style=${{left: `${dot}%`}}></span>`}
      </div>
      <div class="scale-labels">
        ${rows.map(
          (row, i) =>
            html`<span
              key=${row.key}
              class=${cx('scale-label', i === 0 && 'first', i === n - 1 && n > 1 && 'last')}
              style=${{left: `${at(i)}%`}}
            >${row.label}</span>`,
        )}
      </div>
    </div>`;
  }

  /**
   * A score answer: the expected score on the scale, then every level's
   * probability. Levels are often whole sentences, so they get rows, not
   * labels under the track.
   */
  function ScoreAnswer({rows, score, tone}) {
    const n = rows.length;
    const at = (i) => (n > 1 ? (i / (n - 1)) * 100 : 50);
    const dot = typeof score === 'number' && n > 1 ? Math.max(0, Math.min(100, (score / (n - 1)) * 100)) : null;
    return html`<div class=${`tone-${tone}`}>
      <div class="scale score-scale">
        <div class="scale-track">
          ${rows.map((row, i) => html`<span key=${row.key} class="scale-tick" style=${{left: `${at(i)}%`}}></span>`)}
          ${dot !== null && html`<span class="scale-dot" style=${{left: `${dot}%`}}></span>`}
        </div>
        <div class="scale-labels numbers">
          ${rows.map(
            (row, i) =>
              html`<span
                key=${row.key}
                class=${cx('scale-label', i === 0 && 'first', i === n - 1 && n > 1 && 'last', row.selected && 'is-selected')}
                style=${{left: `${at(i)}%`}}
              >${i}</span>`,
          )}
        </div>
      </div>
      <div class="bars wide levels">
        ${rows.map((row, i) => {
          const width = Math.max(0, Math.min(1, row.probability || 0)) * 100;
          return html`
            <span key=${row.key + 'l'} class=${cx('level-label', row.selected && 'is-selected')} title=${row.label}>
              <span class="level-num">${i}</span><span class="level-text">${formatInlineCode(row.label)}</span>
            </span>
            <span key=${row.key + 'b'} class="bar">
              <span class=${cx('bar-fill', row.selected && 'is-selected')} style=${{width: `${width}%`}}></span>
            </span>
            <span key=${row.key + 'v'} class=${cx('bar-value', row.selected && 'is-selected')}>
              ${DP.formatProbability(row.probability)}
            </span>
          `;
        })}
      </div>
    </div>`;
  }

  function AnswerBlock({question, answer, error, stale, loading}) {
    const tone = TYPES[question.type].tone;
    if (loading && !answer) {
      return html`<div class="answer" aria-busy="true">
        <div class="skeleton"><i style="width: 46%"></i><i style="width: 72%"></i><i style="width: 30%"></i></div>
      </div>`;
    }
    if (error && !answer) {
      return html`<div class="answer">
        <div class="answer-error"><${Icon} name="circle-alert" size=${16} /><span>${error}</span></div>
      </div>`;
    }
    if (!answer) return null;
    const rows = DP.answerRows(question, answer);
    const n = rows.length;
    return html`<div class=${cx('answer', (stale || loading) && 'is-stale')}>
      <div class="answer-head">
        <span class="mono">answers.${question.key}</span>
        <span class="meta">
          ${question.type === 'score' &&
          html`<span>score <b>${typeof answer.score === 'number' ? answer.score.toFixed(2) : '–'} / ${n - 1}</b></span>`}
          ${typeof answer.confidence === 'number' &&
          html`<span>confidence <b>${DP.formatProbability(answer.confidence)}</b></span>`}
          ${stale && !loading && html`<span>out of date</span>`}
        </span>
      </div>
      ${question.type === 'score'
        ? html`<${ScoreAnswer} rows=${rows} score=${answer.score} tone=${tone} />`
        : html`<${Bars} rows=${rows} tone=${tone} wide />`}
    </div>`;
  }

  // --------------------------------------------------------------- Header

  function TopBar({view, onHome, codeOpen, onCode, keyLinked, onKey, theme, onTheme}) {
    return html`<header class="topbar">
      <div class="topbar-left">
        <a class="brand" href="#/" aria-label="Home" onClick=${(e) => {
          e.preventDefault();
          onHome();
        }}>
          <span>Home</span>
        </a>
      </div>
      <div class="topbar-right">
        ${view === 'work' &&
        html`<button class="btn btn-sm code-chip" aria-pressed=${codeOpen ? 'true' : 'false'} onClick=${onCode}>
          <${Icon} name="code" size=${15} /><span class="label-wide">Get code</span>
        </button>`}
        <button
          class="btn btn-ghost icon-btn key-btn"
          onClick=${onKey}
          title=${keyLinked ? 'Gemini API key linked' : 'Link a Gemini API Key'}
          aria-label=${keyLinked ? 'Gemini API key linked' : 'Link a Gemini API Key'}
        >
          <${Icon} name="key-round" size=${17} />
          ${keyLinked && html`<span class="key-dot" aria-hidden="true"></span>`}
        </button>
        <a class="btn btn-ghost icon-btn" href=${DOCS_URL} target="_blank" rel="noopener noreferrer" title="Gemini API docs" aria-label="Gemini API docs">
          <${Icon} name="book-open" size=${17} />
        </a>
        <button
          class="btn btn-ghost icon-btn"
          onClick=${onTheme}
          title=${theme === 'dark' ? 'Light theme' : 'Dark theme'}
          aria-label=${theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          <${Icon} name=${theme === 'dark' ? 'sun' : 'moon'} size=${17} />
        </button>
      </div>
    </header>`;
  }

  // ----------------------------------------------------------------- Home

  const TYPE_SAMPLES = {
    noul: [
      {key: 't', label: 'true', probability: 0.92, selected: true},
      {key: 'f', label: 'false', probability: 0.08, selected: false},
    ],
    choice: [
      {key: 'b', label: 'billing', probability: 0.95, selected: true},
      {key: 't', label: 'technical', probability: 0.04, selected: false},
      {key: 's', label: 'shipping', probability: 0.01, selected: false},
    ],
    score: [
      {key: '0', label: 'Cosmetic', probability: 0.2},
      {key: '1', label: 'Workaround', probability: 0.5, selected: true},
      {key: '2', label: 'Blocked', probability: 0.3},
    ],
  };

  // Home cards use the workshop's kind-card shell (studio/studio-space-empty,
  // "What is it for?"): a 30px mark, a 13px title over a 12px muted line, no
  // shadow, and the staggered house-entrance (entranceDelay: min(i, 10) * 0.03s).
  const entranceDelay = (i) => `${Math.min(i, 10) * 0.03}s`;

  function TypeCard({type, onStart, index}) {
    const meta = TYPES[type];
    return html`<button class="kind-card type-card house-entrance" style=${{animationDelay: entranceDelay(index)}} onClick=${() => onStart(type)}>
      <div class="type-card-head">
        <span class=${cx('kind-mark tinted', `tone-${meta.tone}`)}><${Icon} name=${meta.icon} size=${16} /></span>
        <span class="kind-text">
          <span class="kind-title">${meta.action}</span>
          <span class="kind-line mono">${type === 'noul' ? 'Boolean' : type}</span>
        </span>
      </div>
      <div class="type-card-quote">“${meta.example}”</div>
      <div class="mini">
        ${type === 'score'
          ? html`<div class="scale-head"><span class="mono">score</span><span class="value">1.10 / 2</span></div>
              <${MiniScale} rows=${TYPE_SAMPLES.score} score=${1.1} tone=${meta.tone} />`
          : html`<${Bars} rows=${TYPE_SAMPLES[type]} tone=${meta.tone} />`}
      </div>
    </button>`;
  }

  function ExampleCard({example, onOpen, index}) {
    return html`<button class="kind-card example-card house-entrance" style=${{animationDelay: entranceDelay(index)}} onClick=${() => onOpen(example)}>
      <span class="kind-mark"><${Icon} name=${example.icon} size=${16} /></span>
      <span class="kind-text">
        <span class="kind-title">${example.title}</span>
      </span>
    </button>`;
  }

  function Home({examples, onStart, onOpen}) {
    return html`<main class="page page-home">
      <section class="hero">
        <h1>Gemini Decisions API Playground</h1>
        <p class="lede">Turn text, images, audio and video into typed answers your app can use to classify, route, and prioritize.</p>
      </section>

      <section class="kind-section" aria-label="Start with a question type">
        <p class="space-label">Start with a question type</p>
        <div class="kind-grid">${TYPE_ORDER.map((t, i) => html`<${TypeCard} key=${t} type=${t} index=${i} onStart=${onStart} />`)}</div>
      </section>

      <section class="kind-section" aria-label="Or open an example">
        <p class="space-label">Or open an example</p>
        <div class="kind-grid">${examples.map((e, i) => html`<${ExampleCard} key=${e.id} example=${e} index=${TYPE_ORDER.length + i} onOpen=${onOpen} />`)}</div>
      </section>
    </main>`;
  }

  // ---------------------------------------------------------------- Input

  function base64ToBlob(data, mimeType) {
    const bytes = atob(data);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
    return new Blob([buffer], {type: mimeType});
  }

  function attachmentTitle(m) {
    if (m.kind === 'url') return `${attachmentLabel(m)} · URL`;
    return `${attachmentLabel(m)}${typeof m.size === 'number' ? ` · ${DP.formatBytes(m.size)}` : ''}`;
  }

  // The lead of a composer chip, as in the workshop's ais-attachment-chip: a
  // 22px thumbnail for an image (a video shows its first frame), otherwise
  // a 16px icon for the kind of file.
  function MediaThumb({item}) {
    if (item.previewUrl && item.mimeType.startsWith('image/')) {
      return html`<span class="chip-thumb"><img src=${item.previewUrl} alt="" /></span>`;
    }
    if (item.previewUrl && item.mimeType.startsWith('video/')) {
      return html`<span class="chip-thumb is-video">
        <video src=${item.previewUrl} muted preload="metadata" aria-hidden="true"></video>
        <${Icon} name="play" size=${10} stroke=${2.4} />
      </span>`;
    }
    return html`<span class="chip-icon"><${Icon} name=${attachmentIcon(item)} size=${16} /></span>`;
  }

  /** A full-size look at an attachment: the image, a player, the PDF or the text. */
  function MediaPreview({item, onClose}) {
    const [url, setUrl] = useState(item.previewUrl || item.uri || item.src || null);
    useEffect(() => {
      if (url || item.kind !== 'binary' || !item.data) return undefined;
      const objectUrl = URL.createObjectURL(base64ToBlob(item.data, item.mimeType));
      setUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }, []);
    let body;
    if (item.kind === 'text') {
      let text = item.text;
      try {
        if (/^\s*[[{]/.test(text)) text = JSON.stringify(JSON.parse(text), null, 2);
      } catch (e) {
        // Not JSON after all; show it as written.
      }
      body = html`<pre class="preview-text">${text}</pre>`;
    } else if (!url) {
      body = html`<div class="preview-empty">This file is still loading.</div>`;
    } else if (item.mimeType.startsWith('image/')) {
      body = html`<img class="preview-media" src=${url} alt=${item.name} />`;
    } else if (item.mimeType.startsWith('video/')) {
      body = html`<video class="preview-media" src=${url} controls autoplay playsinline></video>`;
    } else if (item.mimeType.startsWith('audio/')) {
      body = html`<div class="preview-audio">
        <span class="tile"><${Icon} name="audio-lines" size=${20} /></span>
        <audio src=${url} controls autoplay></audio>
      </div>`;
    } else if (item.mimeType === 'application/pdf') {
      body = html`<div class="preview-pdf-unsupported">
        <div class="preview-pdf-icon"><${Icon} name="file-text" size=${36} /></div>
        <div class="preview-pdf-title">PDF viewing is not supported</div>
        <div class="preview-pdf-desc">
          In-browser preview is unavailable for PDF files in this environment. The document remains attached and will be processed by the Decisions API.
        </div>
        ${url && html`<a class="btn preview-pdf-download" href=${url} download=${item.name || 'document.pdf'}>
          <${Icon} name="file-text" size=${16} />
          <span>Download ${item.name || 'document.pdf'}</span>
        </a>`}
      </div>`;
    } else {
      body = html`<div class="preview-empty">Preview is not available for this file.</div>`;
    }
    return html`<${Dialog} title=${item.name} description=${attachmentTitle(item)} onClose=${onClose} wide>
      <div class="preview">${body}</div>
    </${Dialog}>`;
  }

  const URL_TYPES = [
    {id: 'image', label: 'Image', icon: 'image', mimeType: 'image/jpeg', placeholder: 'https://example.com/photo.jpg'},
    {id: 'audio', label: 'Audio', icon: 'audio-lines', mimeType: 'audio/mpeg', placeholder: 'https://example.com/clip.mp3'},
    {id: 'video', label: 'Video', icon: 'video', mimeType: 'video/mp4', placeholder: 'https://example.com/video.mp4'},
    {id: 'pdf', label: 'PDF', icon: 'file-text', mimeType: 'application/pdf', placeholder: 'https://example.com/document.pdf'},
  ];

  function detectUrlKind(rawUrl) {
    const inferred = inferMimeType(rawUrl, '');
    if (inferred.startsWith('image/')) return 'image';
    if (inferred.startsWith('audio/')) return 'audio';
    if (inferred.startsWith('video/')) return 'video';
    if (inferred === 'application/pdf') return 'pdf';
    return null;
  }

  function UrlDialog({initialKind, onAdd, onClose}) {
    const [kind, setKind] = useState(() => (URL_TYPES.some((t) => t.id === initialKind) ? initialKind : 'image'));
    const [value, setValue] = useState('');
    const [error, setError] = useState(null);
    const input = useRef(null);
    useLayoutEffect(() => {
      if (input.current) input.current.focus();
    }, []);
    const activeType = URL_TYPES.find((t) => t.id === kind) || URL_TYPES[0];
    const update = (next) => {
      setValue(next);
      if (error) setError(null);
      const detected = detectUrlKind(next.trim());
      if (detected) setKind(detected);
    };
    const submit = () => {
      const trimmed = value.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch (e) {
        setError('Enter a valid http:// or https:// URL.');
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('URL must start with http:// or https://.');
        return;
      }
      const inferred = inferMimeType(parsed.pathname, '');
      const matchesKind =
        (kind === 'image' && inferred.startsWith('image/')) ||
        (kind === 'audio' && inferred.startsWith('audio/')) ||
        (kind === 'video' && inferred.startsWith('video/')) ||
        (kind === 'pdf' && inferred === 'application/pdf');
      const mimeType = matchesKind ? inferred : activeType.mimeType;
      onAdd(parsed.href, mimeType);
    };
    return html`<${Dialog}
      title="Add media from URL"
      description="Attach a public image, audio, video, or PDF URL to pass directly to the Decisions API."
      onClose=${onClose}
    >
      <div style="display: flex; flex-direction: column; gap: 14px">
        <div>
          <div class="field-label"><span>Media type</span></div>
          <div class="segmented" role="radiogroup" aria-label="Media type">
            ${URL_TYPES.map(
              (t) => html`<button
                key=${t.id}
                type="button"
                role="radio"
                aria-checked=${t.id === kind ? 'true' : 'false'}
                onClick=${() => setKind(t.id)}
              >
                <${Icon} name=${t.icon} size=${15} /> ${t.label}
              </button>`,
            )}
          </div>
        </div>
        <div>
          <label class="field-label" for="media-url"><span>URL</span></label>
          <input
            id="media-url"
            ref=${input}
            class="input key-input mono"
            type="url"
            autocomplete="off"
            spellcheck="false"
            placeholder=${activeType.placeholder}
            aria-invalid=${error ? 'true' : 'false'}
            value=${value}
            onInput=${(e) => update(e.currentTarget.value)}
            onKeyDown=${(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          ${error && html`<div class="field-error" role="alert"><${Icon} name="circle-alert" size=${14} /><span>${error}</span></div>`}
        </div>
        <div class="dialog-foot" style="margin-top: 2px">
          <span></span>
          <span class="dialog-actions">
            <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
            <button class="btn btn-primary" onClick=${submit} disabled=${!value.trim()}>
              Add ${activeType.label.toLowerCase()}
            </button>
          </span>
        </div>
      </div>
    </${Dialog}>`;
  }

  /** All file types supported by the Decisions API. */
  const ACCEPT_FILES =
    'image/*,audio/*,video/*,application/pdf,application/json,text/*,.jpg,.jpeg,.png,.webp,.gif,.avif,.heic,.heif,.bmp,.svg,.mp3,.wav,.m4a,.aac,.ogg,.oga,.flac,.opus,.weba,.aiff,.wma,.mp4,.mov,.webm,.mkv,.m4v,.avi,.mpeg,.mpg,.3gp,.flv,.wmv,.pdf,.json,.txt,.md,.csv,.tsv,.log,.xml,.yaml,.yml';

  /** The prompt bar: input text and files, run status, and Run. */
  // The prompt box, ported from the workshop's ais-chat-input (ui/chat-input):
  // the attachment chips above the words, the words box, then a row with the
  // "+" button and the run status at the left and JSON and Run at the right.
  // The workshop's mic, Tools, key and agent chips are switched off here.
  function Composer({text, media, onText, onAddFiles, onRemoveFile, onPreview, error, status, running, onRun, onJson}) {
    const fileInput = useRef(null);
    const [dragging, setDragging] = useState(false);
    const depth = useRef(0);
    const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
    const uploadMenuRef = useRef(null);
    const closeUploadMenu = useCallback(() => setUploadMenuOpen(false), []);
    useDismiss(uploadMenuOpen, closeUploadMenu, uploadMenuRef);
    // As the workshop's isDisabledState: off while running, or with nothing to
    // send (attachments alone are enough, its allowEmpty).
    const empty = !text.trim() && !media.length;
    const runOff = running || empty;
    const openPicker = () => {
      setUploadMenuOpen(false);
      if (fileInput.current) fileInput.current.click();
    };
    const onDrop = (e) => {
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (e.dataTransfer && e.dataTransfer.files.length) onAddFiles([...e.dataTransfer.files]);
    };
    return html`<div class="composer-dock">
      <div
        class=${cx('prompt-box-container composer', dragging && 'is-dragging')}
        onDragEnter=${(e) => {
          if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver=${(e) => dragging && e.preventDefault()}
        onDragLeave=${() => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setDragging(false);
        }}
        onDrop=${onDrop}
      >
        ${media.length > 0 &&
        html`<div class="composer-files">
          ${media.map(
            (m) => html`<div class="attachment-chip house-entrance" key=${m.id}>
              <button class="attachment-chip-open" title=${`Preview ${m.name}${m.uri ? ` (${m.uri})` : ''}`} onClick=${() => onPreview(m.id)}>
                <${MediaThumb} item=${m} />
                <span class="attachment-chip-title">${m.name}</span>
                <span class="attachment-chip-detail">${attachmentTitle(m)}</span>
              </button>
              <button class="attachment-chip-remove" aria-label=${`Remove ${m.name}`} onClick=${() => onRemoveFile(m.id)}>
                <${Icon} name="x" size=${13} />
              </button>
            </div>`,
          )}
        </div>`}
        <div class="composer-words">
          <label class="sr-only" for="state-text">Input</label>
          <${AutoTextarea}
            id="state-text"
            className="prompt-textarea prompt-words composer-text"
            minRows=${1}
            value=${text}
            placeholder="Paste a support ticket, a review, a diff, a transcript… anything you want to decide on."
            onInput=${(e) => onText(e.currentTarget.value)}
            onKeyDown=${(e) => {
              // Enter runs; Shift+Enter starts a new line.
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
                e.preventDefault();
                if (!runOff) onRun();
              }
            }}
            onPaste=${(e) => {
              const files = e.clipboardData ? [...e.clipboardData.files] : [];
              if (files.length) {
                e.preventDefault();
                onAddFiles(files);
              }
            }}
          />
        </div>
        ${error && html`<div class="field-error composer-error" role="alert"><${Icon} name="circle-alert" size=${14} />${error}</div>`}
        <div class="composer-row">
          <div class="composer-row-left">
            <div class="upload-menu-anchor" ref=${uploadMenuRef}>
              <button
                type="button"
                class="prompt-btn-icon composer-add"
                title="Add files"
                aria-label="Add files"
                aria-haspopup="true"
                aria-expanded=${uploadMenuOpen ? 'true' : 'false'}
                onClick=${() => setUploadMenuOpen(!uploadMenuOpen)}
                disabled=${media.length >= LIMITS.files}
              >
                <${Icon} name="circle-plus" />
              </button>
              ${uploadMenuOpen &&
              html`<div class="upload-menu" role="menu">
                <button
                  type="button"
                  class="upload-menu-item"
                  onClick=${openPicker}
                >
                  <${Icon} name="upload" size=${17} />
                  <span>Upload from computer</span>
                </button>
                <div class="upload-menu-sep"></div>
                <div class="upload-menu-disclaimer">
                  <p>
                    By using this feature, you confirm that you have the necessary rights to any content that you upload. Do not generate content that infringes on others’ intellectual property or privacy rights. Your use of this generative AI service is subject to our <a href="https://policies.google.com/terms/generative-ai/use-policy" target="_blank" rel="noopener noreferrer">Prohibited Use Policy</a>.
                  </p>
                  <p>
                    Please note that uploads, including those from Google Workspace, may be used to develop and improve Google products and services in accordance with our <a href="https://aistudio.google.com/docs/terms?e=0" target="_blank" rel="noopener noreferrer">terms</a>.
                  </p>
                </div>
              </div>`}
            </div>
            <input
              ref=${fileInput}
              type="file"
              accept=${ACCEPT_FILES}
              multiple
              hidden
              onChange=${(e) => {
                const files = [...e.currentTarget.files];
                e.currentTarget.value = '';
                if (files.length) onAddFiles(files);
              }}
            />
            ${status}
          </div>
          <div class="composer-row-right">
            <button type="button" class="prompt-btn prompt-btn-primary composer-btn" onClick=${onJson} title="View the request and response JSON">
              <${Icon} name="braces" /> JSON
            </button>
            <button
              type="submit"
              class=${cx('prompt-btn prompt-btn-run composer-btn composer-run', runOff && 'is-off')}
              onClick=${onRun}
              disabled=${runOff}
              aria-label="Run"
              title="Run"
            >
              ${running ? html`<span class="composer-spinner" aria-hidden="true"></span>` : html`<span class="composer-run-label">Run</span>`}
              <${Icon} name="corner-down-left" size=${15} />
            </button>
          </div>
        </div>
      </div>
      <div class="composer-disclaimer">
        <p>
          For this playground, each prompt makes 2 calls with your API key: a short guardrail check and the main request.
        </p>
      </div>
    </div>`;
  }

  // ------------------------------------------------------------ Questions

  function OptionsEditor({question, issues, onChange}) {
    const update = (uid, patch) =>
      onChange({options: question.options.map((o) => (o.uid === uid ? {...o, ...patch} : o))});
    const add = () => {
      const option = DP.newOption();
      onChange({options: [...question.options, option]}, {focus: `opt-${option.uid}`});
    };
    return html`<div>
      <div class="field-label"><span>Options</span><span class="hint-sm">The model picks exactly one</span></div>
      <div class="list">
        ${question.options.map(
          (option, i) => html`<div class="list-row" key=${option.uid}>
            <span class="item-icon"><${Icon} name="circle-dot" size=${14} /></span>
            <div class="option-key-wrap">
              <input
                id=${`opt-${option.uid}`}
                class="input mono"
                value=${option.label}
                placeholder=${`option_${i + 1}`}
                aria-label=${`Option ${i + 1} key`}
                spellcheck="false"
                autocomplete="off"
                onInput=${(e) => update(option.uid, {label: e.currentTarget.value})}
                onBlur=${(e) => {
                  // Normalize to an API key, unless that would erase the name.
                  const key = DP.toKey(e.currentTarget.value);
                  if (key && key !== option.label) update(option.uid, {label: key});
                }}
                onKeyDown=${(e) => {
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.isComposing && question.options.length < LIMITS.maxOptions) {
                    e.preventDefault();
                    add();
                  }
                }}
              />
            </div>
            <input
              class="input option-desc"
              value=${option.description}
              placeholder="When to pick it (optional)"
              aria-label=${`Option ${i + 1} description`}
              onInput=${(e) => update(option.uid, {description: e.currentTarget.value})}
            />
            <button
              class="x-btn"
              aria-label=${`Remove option ${i + 1}`}
              disabled=${question.options.length <= LIMITS.minOptions}
              onClick=${() => onChange({options: question.options.filter((o) => o.uid !== option.uid)})}
            >
              <${Icon} name="x" size=${13} />
            </button>
          </div>`,
        )}
      </div>
      ${issues.options && html`<div class="field-error"><${Icon} name="circle-alert" size=${14} />${issues.options}</div>`}
      ${question.options.length < LIMITS.maxOptions &&
      html`<button class="ghost-btn muted list-add" onClick=${add}>
        <${Icon} name="plus" size=${14} /> Add option
      </button>`}
    </div>`;
  }

  function LevelsEditor({question, issues, onChange}) {
    const update = (uid, label) => onChange({levels: question.levels.map((l) => (l.uid === uid ? {...l, label} : l))});
    const add = () => {
      const level = DP.newLevel();
      onChange({levels: [...question.levels, level]}, {focus: `lvl-${level.uid}`});
    };
    return html`<div>
      <div class="field-label"><span>Levels</span><span class="hint-sm">Lowest first. Scores run from 0 to ${question.levels.length - 1}.</span></div>
      <div class="list">
        ${question.levels.map(
          (level, i) => html`<div class="list-row level" key=${level.uid}>
            <span class="item-icon level-index">${i}</span>
            <input
              id=${`lvl-${level.uid}`}
              class="input"
              value=${level.label}
              placeholder=${i === 0 ? 'Lowest level' : `Level ${i}`}
              aria-label=${`Level ${i}`}
              onInput=${(e) => update(level.uid, e.currentTarget.value)}
              onKeyDown=${(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.isComposing && question.levels.length < LIMITS.maxLevels) {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button
              class="x-btn"
              aria-label=${`Remove level ${i}`}
              disabled=${question.levels.length <= LIMITS.minLevels}
              onClick=${() => onChange({levels: question.levels.filter((l) => l.uid !== level.uid)})}
            >
              <${Icon} name="x" size=${13} />
            </button>
          </div>`,
        )}
      </div>
      ${issues.levels && html`<div class="field-error"><${Icon} name="circle-alert" size=${14} />${issues.levels}</div>`}
      ${question.levels.length < LIMITS.maxLevels &&
      html`<button class="ghost-btn muted list-add" onClick=${add}>
        <${Icon} name="plus" size=${14} /> Add level
      </button>`}
    </div>`;
  }

  function BooleanEditor({question, onChange}) {
    return html`<div class="editor-row" style="grid-template-columns: 1fr 1fr; align-items: start">
      <div>
        <label class="field-label" for=${`${question.uid}-true`}><span>True when</span><span class="hint-sm">Optional</span></label>
        <input
          id=${`${question.uid}-true`}
          class="input"
          value=${question.trueDescription}
          placeholder="Describe a yes"
          onInput=${(e) => onChange({trueDescription: e.currentTarget.value})}
        />
      </div>
      <div>
        <label class="field-label" for=${`${question.uid}-false`}><span>False when</span><span class="hint-sm">Optional</span></label>
        <input
          id=${`${question.uid}-false`}
          class="input"
          value=${question.falseDescription}
          placeholder="Describe a no"
          onInput=${(e) => onChange({falseDescription: e.currentTarget.value})}
        />
      </div>
    </div>`;
  }

  /**
   * A question's answer as a chip at the right of its card, so answers don't
   * resize the card. Selecting it shows every probability.
   */
  function AnswerChip({question, answer, error, stale, loading}) {
    const [open, setOpen] = useState(false);
    const [up, setUp] = useState(false);
    const ref = useRef(null);
    const close = useCallback(() => setOpen(false), []);
    useDismiss(open, close, ref);
    useLayoutEffect(() => {
      if (!open || !ref.current) return;
      // Open upward when there's no room above the prompt bar.
      const rect = ref.current.getBoundingClientRect();
      const dock = document.querySelector('.composer-dock');
      const floor = dock ? dock.getBoundingClientRect().top : window.innerHeight;
      setUp(floor - rect.bottom < 300 && rect.top > 320);
    }, [open]);
    if (loading && !answer) {
      return html`<span class="answer-chip is-loading" role="status" aria-label="Answering"><i></i></span>`;
    }
    if (!answer && !error) return null;
    const tone = TYPES[question.type].tone;
    let face;
    if (answer) {
      const head = DP.answerHeadline(question, answer);
      const p = typeof head.probability === 'number' ? Math.max(0, Math.min(1, head.probability)) : 0;
      face = html`<span class="chip-label">${head.label}</span>
        <span class="chip-prob">${DP.formatProbability(head.probability)}</span>
        <span class="chip-bar"><span style=${{width: `${p * 100}%`}}></span></span>`;
    } else {
      face = html`<${Icon} name="circle-alert" size=${14} /><span class="chip-label">Failed</span>`;
    }
    return html`<span class="answer-anchor" ref=${ref} onClick=${(e) => e.stopPropagation()}>
      <button
        class=${cx('answer-chip', `tone-${tone}`, !answer && 'is-error', answer && (stale || loading) && 'is-stale')}
        aria-haspopup="dialog"
        aria-expanded=${open ? 'true' : 'false'}
        title=${stale ? 'Out of date. Run again to update.' : 'Show every probability'}
        onClick=${() => setOpen(!open)}
      >
        ${face}
      </button>
      ${open &&
      html`<div class=${cx('answer-pop', up && 'is-up')} role="dialog" aria-label=${`Answer to ${question.key}`}>
        <${AnswerBlock} question=${question} answer=${answer} error=${error} stale=${stale} loading=${loading} />
      </div>`}
    </span>`;
  }

  function QuestionCard(props) {
    const {question, open, issues, flagged, answer, error, stale, loading} = props;
    const {onToggle, onChange, onType, onRemove} = props;
    const cardRef = useRef(null);
    useEffect(() => {
      if (open && cardRef.current) {
        const timer = setTimeout(() => {
          if (cardRef.current && typeof cardRef.current.scrollIntoView === 'function') {
            cardRef.current.scrollIntoView({behavior: 'smooth', block: 'nearest'});
          }
        }, 80);
        return () => clearTimeout(timer);
      }
    }, [open]);
    const meta = TYPES[question.type];
    const bodyId = `${question.uid}-body`;
    return html`<article ref=${cardRef} class=${cx('qcard', open && 'is-open')}>
      <div class="qcard-row" onClick=${onToggle}>
        <button class="qcard-main" aria-expanded=${open ? 'true' : 'false'} aria-controls=${bodyId}>
          <span class=${cx('qcard-icon', `tone-${meta.tone}`)}><${Icon} name=${meta.icon} size=${16} /></span>
          <span class="qcard-label">
            <span class=${cx('qcard-prompt', !question.instructions.trim() && 'is-empty')}>
              ${question.instructions.trim()
                ? formatInlineCode(question.instructions.trim())
                : 'No question yet. Select to write one.'}
            </span>
            <span class="qcard-hint">
              ${meta.label}
              ${flagged && !open && html`<span class="qcard-flag"><${Icon} name="circle-alert" size=${12} />Needs attention</span>`}
            </span>
          </span>
        </button>
        <span class="qcard-key">${question.key}</span>
        <${AnswerChip} question=${question} answer=${answer} error=${error} stale=${stale} loading=${loading} />
        <span class="qcard-chev" aria-hidden="true">
          <${Icon} name="chevron-down" size=${16} className="chev" />
        </span>
      </div>
      ${open &&
      html`<div class="qcard-body" id=${bodyId}>
        <div class="editor">
          <div class="editor-row">
            <div>
              <div class="field-label"><span>Type</span></div>
              <div class="pchips" role="radiogroup" aria-label="Question type">
                ${TYPE_ORDER.map(
                  (t) => html`<button
                    key=${t}
                    role="radio"
                    class=${`pchip tone-${TYPES[t].tone}`}
                    aria-checked=${t === question.type ? 'true' : 'false'}
                    onClick=${() => onType(t)}
                  >
                    <${Icon} name=${TYPES[t].icon} size=${14} /> ${TYPES[t].label}
                  </button>`,
                )}
              </div>
            </div>
            <div>
              <label class="field-label" for=${`${question.uid}-key`}><span>Key</span><span class="hint-sm">In the response</span></label>
              <input
                id=${`${question.uid}-key`}
                class="input mono"
                value=${question.key}
                spellcheck="false"
                autocomplete="off"
                aria-invalid=${issues.key ? 'true' : 'false'}
                maxlength="64"
                onInput=${(e) => onChange({key: e.currentTarget.value.replace(/\s+/g, '_')})}
                onBlur=${(e) => {
                  const key = e.currentTarget.value
                    .trim()
                    .replace(/[^A-Za-z0-9_-]+/g, '_')
                    .replace(/^_+|_+$/g, '');
                  if (key && key !== question.key) onChange({key});
                }}
              />
            </div>
          </div>
          ${issues.key && html`<div class="field-error" style="margin-top: -8px"><${Icon} name="circle-alert" size=${14} />${issues.key}</div>`}
          <div>
            <label class="field-label" for=${`${question.uid}-instructions`}>
              <span>Question</span>
            </label>
            <${AutoTextarea}
              id=${`${question.uid}-instructions`}
              className="instructions"
              minRows=${2}
              value=${question.instructions}
              placeholder=${`e.g. ${meta.example}`}
              aria-invalid=${issues.instructions ? 'true' : 'false'}
              onInput=${(e) => onChange({instructions: e.currentTarget.value})}
            />
            ${issues.instructions &&
            html`<div class="field-error"><${Icon} name="circle-alert" size=${14} />${issues.instructions}</div>`}
          </div>
          ${question.type === 'choice' && html`<${OptionsEditor} question=${question} issues=${issues} onChange=${onChange} />`}
          ${question.type === 'score' && html`<${LevelsEditor} question=${question} issues=${issues} onChange=${onChange} />`}
          ${question.type === 'noul' && html`<${BooleanEditor} question=${question} onChange=${onChange} />`}
          <div class="editor-foot">
            <span class="spacer"></span>
            <button class="ghost-btn muted" onClick=${onRemove}>Delete</button>
            <button class="ghost-btn" onClick=${onToggle}>Done</button>
          </div>
        </div>
      </div>`}
    </article>`;
  }

  // ---------------------------------------------------------- Run status

  function RunStatus({run, stale, issue, showIssue, modelLabel, hasMedia, resolution, onResolution}) {
    let status;
    if (run && run.status === 'running') {
      status = html`<div class="run-status" role="status">
        <${Icon} name="loader-circle" size=${15} className="spin" /><span class="text">Asking ${modelLabel}…</span>
      </div>`;
    } else if (issue && showIssue) {
      status = html`<div class="run-status is-warning" role="status">
        <${Icon} name="circle-alert" size=${15} /><span class="text">${issue}</span>
      </div>`;
    } else if (run && run.status === 'error') {
      status = html`<div class="run-status is-error" role="status">
        <${Icon} name="circle-alert" size=${15} /><span class="text">${run.error.title}</span>
      </div>`;
    } else if (run && run.status === 'done' && !stale) {
      const r = run.response;
      const failed = r.errors ? Object.keys(r.errors).length : 0;
      const tokens = r.usage ? r.usage.total_input_tokens : null;
      status = html`<div class="run-status" role="status">
        <span class="text">
          <b title=${r.round_trip_ms ? `Model time. ${DP.formatMs(r.round_trip_ms)} round trip from this page.` : 'Model time'}>${DP.formatMs(r.latency_ms)}</b>
          ${tokens !== null && html`<span class="optional"><span class="sep"> · </span>${tokens.toLocaleString()} input tokens</span>`}
          ${failed > 0 && html`<span class="sep"> · </span>${failed} failed`}
        </span>
      </div>`;
    } else if (run && stale) {
      status = html`<div class="run-status" role="status">
        <${Icon} name="rotate-ccw" size=${14} /><span class="text">Edited since the last run</span>
      </div>`;
    } else {
      status = null;
    }
    return html`<div class="run-status-wrap">
      ${hasMedia && html`<${ResolutionChip} value=${resolution} onChange=${onResolution} />`}
      ${status}
    </div>`;
  }

  /** Media resolution, set from a chip in the prompt bar. */
  function ResolutionChip({value, onChange}) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const close = useCallback(() => setOpen(false), []);
    useDismiss(open, close, ref);
    const level = DP.MEDIA_RESOLUTIONS.find((r) => r.id === value) || DP.MEDIA_RESOLUTIONS[0];
    return html`<div class="menu-anchor" ref=${ref}>
      <button
        class=${cx('tag tag-btn', level.api && 'is-set')}
        aria-haspopup="menu"
        aria-expanded=${open ? 'true' : 'false'}
        title="Media resolution"
        onClick=${() => setOpen(!open)}
      >
        <${Icon} name="sliders-horizontal" size=${12} />
        ${level.api ? `${level.label} resolution` : 'Media resolution'}
        <${Icon} name="chevron-down" size=${12} className="chev" />
      </button>
      ${open &&
      html`<div class="menu menu-up" role="menu" aria-label="Media resolution">
        <div class="menu-label menu-label-row"><span>Media resolution</span><span class="mono">media_resolution</span></div>
        ${DP.MEDIA_RESOLUTIONS.map(
          (r) => html`<button
            key=${r.id}
            class="menu-item"
            role="menuitemradio"
            aria-checked=${r.id === level.id ? 'true' : 'false'}
            onClick=${() => {
              onChange(r.id);
              setOpen(false);
            }}
          >
            <span>
              <div class="title">${r.label}</div>
              <div class="desc">${r.detail}</div>
            </span>
            ${r.id === level.id && html`<${Icon} name="check" size=${16} className="check" />`}
          </button>`,
        )}
        ${!DIRECT &&
        html`<div class="menu-sep"></div>
          <div class="menu-foot">
            <${Icon} name="info" size=${14} />
            <span>
              The local backend doesn't take this yet, so the playground downsizes images instead. Token counts won't change,
              and video is sent as it is.
            </span>
          </div>`}
      </div>`}
    </div>`;
  }

  // ---------------------------------------------------------- Side panel

  /** Links a Gemini API key. Runs that call the Decisions API use it. */
  /** The key as the workshop's key-card shows it: its ends, the middle masked. Display only. */
  function maskKey(key) {
    const k = String(key || '');
    return k.length > 10 ? `${k.slice(0, 4)}${'•'.repeat(8)}${k.slice(-4)}` : '•'.repeat(12);
  }

  function KeyDialog({apiKey, onSave, onClose}) {
    // A linked key shows on its card; the field starts empty for a replacement.
    const [value, setValue] = useState('');
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState(null);
    const input = useRef(null);
    const checkAbort = useRef(null);
    useLayoutEffect(() => {
      if (input.current) input.current.focus();
    }, []);
    useEffect(
      () => () => {
        if (checkAbort.current) checkAbort.current.abort();
      },
      [],
    );
    const save = async () => {
      const cleaned = cleanApiKey(value);
      if (!cleaned || checking) return;
      setError(null);
      setChecking(true);
      if (checkAbort.current) checkAbort.current.abort();
      const controller = new AbortController();
      checkAbort.current = controller;
      try {
        const res = await verifyApiKey(cleaned, controller.signal);
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setChecking(false);
          setError(res.error);
          return;
        }
        setChecking(false);
        onSave(cleaned);
      } catch (e) {
        if (controller.signal.aborted) return;
        setChecking(false);
        setError("Couldn't reach the Decisions API. Check your connection, then try again.");
      }
    };
    const update = (next) => {
      setValue(next);
      if (error) setError(null);
    };
    return html`<${Dialog}
      title="Link a Gemini API Key"
      description="Runs call the Decisions API with your key. It's stored only in this browser."
      onClose=${onClose}
    >
      <div
        onPaste=${(e) => {
          if (e.target === input.current || checking) return;
          const pasted = e.clipboardData ? e.clipboardData.getData('text') : '';
          if (pasted) {
            e.preventDefault();
            update(pasted);
            if (input.current) input.current.focus();
          }
        }}
      >
        ${apiKey &&
        html`<div class="key-card">
          <div class="key-card-head">
            <${Icon} name="key-round" size=${14} />
            <span class="key-card-title">API key</span>
            <span class="key-card-meta">Linked in this browser</span>
          </div>
          <div class="key-card-row">
            <code class="key-card-code">${maskKey(apiKey)}</code>
            <button class="ghost-btn muted key-unlink" disabled=${checking} onClick=${() => onSave('')}>Unlink</button>
          </div>
        </div>`}
        <label class=${cx('key-field-label', !apiKey && 'sr-only')} for="api-key">${apiKey ? 'Replace it' : 'Gemini API key'}</label>
        <input
          id="api-key"
          ref=${input}
          class="input key-input mono"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder=${apiKey ? 'Paste a new key' : 'Paste your API key'}
          aria-invalid=${error ? 'true' : 'false'}
          disabled=${checking}
          value=${value}
          onInput=${(e) => update(e.currentTarget.value)}
          onChange=${(e) => update(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
        />
        ${error && html`<div class="field-error" role="alert"><${Icon} name="circle-alert" size=${14} /><span>${error}</span></div>`}
        <div class="dialog-foot">
          <a class="ghost-btn muted key-link" href=${GET_KEY_URL} target="_blank" rel="noopener noreferrer">
            Get a key in AI Studio <${Icon} name="external-link" size=${13} />
          </a>
          <span class="dialog-actions">
            <button class="filter-chip dialog-cta" onClick=${save} disabled=${!cleanApiKey(value) || checking}>
              ${checking && html`<${Icon} name="loader-circle" size=${14} className="spin" />`}
              ${checking ? 'Linking…' : apiKey ? 'Replace key' : 'Link key'}
            </button>
          </span>
        </div>
      </div>
    </${Dialog}>`;
  }

  function CodeDialog({request, onCopy, onClose}) {
    const [tab, setTab] = useState('python');
    const tabs = {
      python: {label: 'Python', language: 'python', code: () => DP.pythonSnippet(request)},
      typescript: {label: 'TypeScript', language: 'typescript', code: () => DP.typescriptSnippet(request)},
      rest: {label: 'REST', language: 'shell', code: () => DP.restSnippet(request)},
    };
    const active = tabs[tab] || tabs.python;
    const code = active.code();
    return html`<${Dialog}
      title="Use it from your code"
      description="Call the Decisions API with this input and these questions. Every question is answered in one request."
      onClose=${onClose}
      wide
    >
      <${CodeBlock}
        tabs=${Object.entries(tabs).map(([id, t]) => ({id, label: t.label}))}
        active=${tab}
        onTab=${setTab}
        code=${code}
        language=${active.language}
        empty=""
        onCopy=${onCopy}
      />
      <p class="dialog-note">
        Uses <span class="mono">${API_MODEL}</span> with the Gemini Decisions API.
      </p>
    </${Dialog}>`;
  }

  /** The request this draft sends and the last response, as JSON. */
  function JsonDialog({request, response, running, runOff, onRun, onCopy, onClose}) {
    const [tab, setTab] = useState('request');
    const code = tab === 'request' ? JSON.stringify(request, null, 2) : response ? JSON.stringify(response, null, 2) : '';
    const emptyAction =
      tab === 'response' && !response && onRun
        ? html`<button
            type="button"
            class="code-run-btn"
            onClick=${onRun}
            disabled=${runOff}
            aria-label="Run"
            title="Run"
          >
            ${running ? html`<span class="composer-spinner" aria-hidden="true"></span>` : html`<span>Run</span>`}
            <${Icon} name="corner-down-left" size=${15} />
          </button>`
        : null;
    return html`<${Dialog}
      title="JSON"
      description=${tab === 'request'
        ? 'The request body for this input and these questions. File contents are shortened.'
        : 'The response to your last run.'}
      onClose=${onClose}
      wide
    >
      <${CodeBlock}
        tabs=${[
          {id: 'request', label: 'Request'},
          {id: 'response', label: 'Response'},
        ]}
        active=${tab}
        onTab=${setTab}
        code=${code}
        language="json"
        empty="Run the questions to see the response."
        emptyAction=${emptyAction}
        onCopy=${onCopy}
      />
    </${Dialog}>`;
  }

  // ------------------------------------------------------------------ App

  function initialTheme() {
    const saved = readStorage(STORAGE.theme, null);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function restoreDraft() {
    const saved = readStorage(STORAGE.draft, null);
    if (!saved || !Array.isArray(saved.questions)) return null;
    try {
      return {
        title: String(saved.title || ''),
        exampleId: saved.exampleId || null,
        text: String(saved.text || ''),
        media: persistableMedia(Array.isArray(saved.media) ? saved.media : []),
        questions: saved.questions.map((q) =>
          DP.makeQuestion({
            key: q.key,
            type: TYPES[q.type] ? q.type : 'choice',
            instructions: q.instructions,
            options: q.options,
            levels: (q.levels || []).map((l) => l.label),
            true_description: q.trueDescription,
            false_description: q.falseDescription,
          }),
        ),
      };
    } catch (e) {
      return null;
    }
  }

  function restoreSettings() {
    const saved = readStorage(STORAGE.settings, null);
    const mediaResolution =
      saved && DP.MEDIA_RESOLUTIONS.some((r) => r.id === saved.mediaResolution) ? saved.mediaResolution : 'default';
    return {mediaResolution};
  }

  function App() {
    const examples = DP.EXAMPLES || [];
    const [view, setView] = useState(routeFromHash);
    const [theme, setTheme] = useState(initialTheme);
    const [draft, setDraft] = useState(() => restoreDraft() || draftFromExample(examples[0]));
    const [openId, setOpenId] = useState(null);
    const [run, setRun] = useState(null);
    const [models, setModels] = useState(FALLBACK_MODELS);
    // The playground always uses the Decisions model; there's no model picker.
    const modelId = FALLBACK_MODELS[0].id;
    const [settings, setSettings] = useState(restoreSettings);
    const [conn, setConn] = useState({status: 'checking'});
    const connRef = useRef(conn);
    connRef.current = conn;
    const healthRef = useRef(null);
    const [showIssues, setShowIssues] = useState(false);
    const [mediaError, setMediaError] = useState(null);
    const [codeOpen, setCodeOpen] = useState(false);
    const [jsonOpen, setJsonOpen] = useState(false);
    const [apiKey, setApiKey] = useState(() => {
      if (IN_AISTUDIO) return '';
      const saved = readStorage(STORAGE.apiKey, '');
      return typeof saved === 'string' ? saved : '';
    });
    const [aiStudioKeyLinked, setAiStudioKeyLinked] = useState(false);
    // {pending}: the key dialog is open; `pending` runs once a key is linked.
    const [keyDialog, setKeyDialog] = useState(null);
    const [urlDialog, setUrlDialog] = useState(null);
    const [previewId, setPreviewId] = useState(null);
    const [toast, setToast] = useState(null);
    const [focusTarget, setFocusTarget] = useState(null);
    const abortRef = useRef(null);
    const runSeq = useRef(0);
    const sessionRef = useRef(0);
    const draftRef = useRef(draft);
    const apiKeyRef = useRef('');
    const aiStudioKeyRef = useRef(false);
    draftRef.current = draft;
    apiKeyRef.current = apiKey;
    aiStudioKeyRef.current = aiStudioKeyLinked;

    const refreshAiStudioKey = useCallback(async () => {
      if (!IN_AISTUDIO) return false;
      try {
        const selected = !!(await window.aistudio.hasSelectedApiKey());
        aiStudioKeyRef.current = selected;
        setAiStudioKeyLinked(selected);
        return selected;
      } catch (e) {
        return aiStudioKeyRef.current;
      }
    }, []);

    const openKeyPrompt = useCallback(async (pending = false) => {
      if (IN_AISTUDIO) {
        try {
          await window.aistudio.openSelectKey();
        } catch (e) {
          // Ignore if host cancels or fails.
        }
        return;
      }
      setKeyDialog({pending});
    }, []);

    // In AI Studio, check if a Paid API Key is selected and open the default
    // Paid Key Linking modal automatically if none is linked yet.
    useEffect(() => {
      if (!IN_AISTUDIO) return undefined;
      let cancelled = false;
      (async () => {
        const selected = await refreshAiStudioKey();
        if (!cancelled && !selected) {
          try {
            await window.aistudio.openSelectKey();
          } catch (e) {
            // Host bridge unavailable.
          }
        }
      })();
      const onCheck = () => {
        if (!cancelled) refreshAiStudioKey();
      };
      window.addEventListener('focus', onCheck);
      document.addEventListener('visibilitychange', onCheck);
      return () => {
        cancelled = true;
        window.removeEventListener('focus', onCheck);
        document.removeEventListener('visibilitychange', onCheck);
      };
    }, [refreshAiStudioKey]);

    // Theme.
    useEffect(() => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle('dark', theme === 'dark');
      writeStorage(STORAGE.theme, theme);
    }, [theme]);

    // Routing: #/ is the zero state, #/playground the workspace.
    useEffect(() => {
      const onHash = () => setView(routeFromHash());
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }, []);
    useEffect(() => {
      window.scrollTo(0, 0);
    }, [view]);

    // Backend detection.
    useEffect(() => {
      let cancelled = false;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 20000);
      const settle = (next) => {
        connRef.current = next;
        if (!cancelled) setConn(next);
      };
      // Only "nothing there" (a network error or a 404) means there's no
      // backend. A slow or failing backend is still tried for each run.
      if (DIRECT) {
        clearTimeout(timer);
        settle({status: 'live'});
        healthRef.current = Promise.resolve();
        return () => {
          cancelled = true;
        };
      }
      healthRef.current = fetch('api/health', {signal: controller.signal, credentials: 'same-origin'})
        .then(async (r) => {
          if (r.status === 404) return settle({status: 'offline'});
          if (!r.ok) return settle({status: 'unavailable', message: `The server returned HTTP ${r.status}.`});
          const health = await r.json();
          if (Array.isArray(health.models) && health.models.length) setModels(health.models);
          settle(health.status === 'ok' ? {status: 'live', user: health.user} : {status: 'unavailable', message: health.message});
        })
        .catch(() =>
          settle(
            timedOut
              ? {status: 'unavailable', message: "The server didn't answer in time. Runs will still try it."}
              : {status: 'offline'},
          ),
        )
        .finally(() => clearTimeout(timer));
      return () => {
        cancelled = true;
        controller.abort();
      };
    }, []);
    useEffect(() => writeStorage(STORAGE.settings, settings), [settings]);
    useEffect(() => {
      if (IN_AISTUDIO) return;
      if (apiKey) writeStorage(STORAGE.apiKey, apiKey);
      else {
        try {
          window.localStorage.removeItem(STORAGE.apiKey);
        } catch (e) {
          // Storage is blocked; nothing was saved.
        }
      }
    }, [apiKey]);

    // Persistence. Media is left out: it can be large, and it is easy to re-add.
    useEffect(() => {
      const id = setTimeout(() => {
        writeStorage(STORAGE.draft, {
          title: draft.title,
          exampleId: draft.exampleId,
          text: draft.text,
          media: persistableMedia(draft.media),
          questions: draft.questions.map((q) => ({...q, uid: undefined})),
        });
      }, 300);
      return () => clearTimeout(id);
    }, [draft]);

    // After a reload, fetch the bytes of any sample files restored from storage.
    useEffect(() => {
      if (!draft.media.some((m) => m.kind === 'binary' && !m.data && m.src)) return;
      const session = sessionRef.current;
      loadExampleMedia(draft.media).then((media) => {
        if (session !== sessionRef.current) return;
        setDraft((d) => ({...d, media: d.media.map((m) => media.find((x) => x.id === m.id) || m)}));
      });
    }, []);

    useEffect(() => {
      if (!toast) return undefined;
      const id = setTimeout(() => setToast(null), 2200);
      return () => clearTimeout(id);
    }, [toast]);

    useEffect(() => {
      if (!focusTarget) return;
      const el = document.getElementById(focusTarget);
      if (el) {
        el.focus();
        if (typeof el.setSelectionRange === 'function' && el.value) el.setSelectionRange(el.value.length, el.value.length);
      }
      setFocusTarget(null);
    }, [focusTarget]);

    // ----------------------------------------------------------- Derived

    const current = signatures({...draft, mediaResolution: settings.mediaResolution}, modelId);
    const isStale = (q) =>
      !!run &&
      !!run.response &&
      (run.sigs.input !== current.input || run.sigs.model !== current.model || run.sigs.q[q.uid] !== current.q[q.uid]);
    const anyStale =
      !!run &&
      !!run.response &&
      (run.sigs.input !== current.input ||
        run.sigs.model !== current.model ||
        draft.questions.some((q) => run.sigs.q[q.uid] !== current.q[q.uid]) ||
        Object.keys(run.sigs.q).some((uid) => !(uid in current.q)));
    const issue = DP.blockingIssue(draft);
    const modelLabel =
      DIRECT || apiKey ? CONFIG.modelLabel || 'Gemini Decisions' : (models.find((m) => m.id === modelId) || FALLBACK_MODELS[0]).label;
    const codeRequest = useMemo(
      () => DP.buildRequest({...draft, model: API_MODEL, mediaResolution: settings.mediaResolution}, {redact: true}),
      [draft, settings.mediaResolution],
    );
    const previewItem = previewId ? draft.media.find((m) => m.id === previewId) : null;

    // ----------------------------------------------------------- Actions

    const updateDraft = (patch) => setDraft((d) => ({...d, ...patch}));

    const goHome = () => {
      if (window.location.hash !== '#/') window.location.hash = '#/';
      setView('home');
    };
    const goWork = () => {
      if (!window.location.hash.startsWith('#/playground')) window.location.hash = '#/playground';
      setView('work');
    };

    const resetSession = (next) => {
      sessionRef.current += 1;
      runSeq.current += 1; // Results of a run still in flight are dropped.
      if (abortRef.current) abortRef.current.abort();
      draft.media.forEach((m) => m.previewUrl && m.previewUrl.startsWith('blob:') && URL.revokeObjectURL(m.previewUrl));
      setDraft(next);
      setRun(null);
      setShowIssues(false);
      setMediaError(null);
      setPreviewId(null);
    };

    /** Drops the answers, and any run still in flight. */
    const clearAnswers = () => {
      runSeq.current += 1;
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = null;
      setRun(null);
    };


    const startBlank = (type) => {
      const question = DP.blankQuestion(type, []);
      resetSession({title: 'Untitled', exampleId: null, text: '', media: [], questions: [question]});
      setOpenId(question.uid);
      goWork();
      setFocusTarget('state-text');
    };

    const openExample = (example) => {
      const next = draftFromExample(example);
      resetSession(next);
      const session = sessionRef.current;
      setOpenId(null);
      goWork();
      loadExampleMedia(next.media).then((media) => {
        if (session !== sessionRef.current) return;
        const merge = (list) => list.map((m) => media.find((x) => x.id === m.id) || m);
        setDraft((d) => (d.exampleId === next.exampleId ? {...d, media: merge(d.media)} : d));
      });
    };

    const setQuestion = (uid, patch, opts) => {
      setDraft((d) => ({...d, questions: d.questions.map((q) => (q.uid === uid ? {...q, ...patch} : q))}));
      if (opts && opts.focus) setFocusTarget(opts.focus);
    };

    const addQuestion = (type) => {
      if (draft.questions.length >= LIMITS.questions) return;
      const question = DP.blankQuestion(type, draft.questions);
      updateDraft({questions: [...draft.questions, question]});
      setOpenId(question.uid);
      setFocusTarget(`${question.uid}-instructions`);
    };

    const removeQuestion = (uid) => {
      updateDraft({questions: draft.questions.filter((q) => q.uid !== uid)});
      if (openId === uid) setOpenId(null);
    };

    const clearQuestions = () => {
      clearAnswers();
      setOpenId(null);
      setShowIssues(false);
      updateDraft({questions: []});
    };

    const changeType = (uid, type) => {
      const used = new Set(draft.questions.filter((q) => q.uid !== uid).map((q) => q.key));
      setQuestion(uid, {type});
      const q = draft.questions.find((x) => x.uid === uid);
      // Default keys follow the type; keys the user chose stay.
      const defaults = {noul: 'yes_no', choice: 'choice', score: 'score'};
      const base = q && Object.values(defaults).find((d) => q.key === d || q.key.startsWith(`${d}_`) && /^\d+$/.test(q.key.slice(d.length + 1)));
      if (base) setQuestion(uid, {type, key: DP.uniqueKey(defaults[type], used)});
    };

    const addFiles = async (files, category = null) => {
      setMediaError(null);
      let count = draftRef.current.media.length;
      for (const file of files) {
        if (count >= LIMITS.files) {
          setMediaError(`You can attach up to ${LIMITS.files} files.`);
          break;
        }
        const mimeType = inferMimeType(file.name, file.type);
        const kind = fileKind(file);
        if (!kind) {
          setMediaError(`${file.name} isn't supported. Attach images, audio, video, PDFs or text files.`);
          continue;
        }
        if (category === 'audio' && (mimeType.startsWith('video/') || /\.mp4$/i.test(file.name))) {
          setMediaError(`${file.name} is a video file. Choose Video to attach .mp4 files.`);
          continue;
        }
        if (category === 'audio' && !mimeType.startsWith('audio/')) {
          setMediaError(`${file.name} isn't an audio file.`);
          continue;
        }
        if (category === 'image' && !mimeType.startsWith('image/')) {
          setMediaError(`${file.name} isn't an image file.`);
          continue;
        }
        if (category === 'video' && !mimeType.startsWith('video/')) {
          setMediaError(`${file.name} isn't a video file.`);
          continue;
        }
        if (category === 'pdf' && mimeType !== 'application/pdf') {
          setMediaError(`${file.name} isn't a PDF file.`);
          continue;
        }
        if (file.size > LIMITS.fileBytes) {
          setMediaError(`${file.name} is ${DP.formatBytes(file.size)}. Files must be under ${DP.formatBytes(LIMITS.fileBytes)}.`);
          continue;
        }
        // Base64 grows files by a third, and the whole request must stay under the request limit.
        const used = draftRef.current.media.reduce((sum, m) => sum + (m.data ? m.data.length : m.text ? m.text.length : m.size || 0), 0);
        const adding = kind === 'text' ? file.size : Math.ceil(file.size / 3) * 4;
        if (used + adding + draftRef.current.text.length > LIMITS.requestBytes * 1.4) {
          setMediaError(`${file.name} would take the request over ${DP.formatBytes(LIMITS.requestBytes)}. Remove a file or use a smaller one.`);
          continue;
        }
        try {
          const base = {id: DP.uid('m'), name: file.name, mimeType, size: file.size, kind};
          const item =
            kind === 'text'
              ? {...base, text: await readAsText(file)}
              : {
                  ...base,
                  data: await readAsBase64(file),
                  previewUrl: /^(image|video|audio)\//.test(mimeType) || mimeType === 'application/pdf' ? URL.createObjectURL(file) : null,
                };
          count += 1;
          setDraft((d) => ({...d, media: [...d.media, item]}));
        } catch (e) {
          setMediaError(`Couldn't read ${file.name}.`);
        }
      }
    };

    const addUrl = (uri, mimeType) => {
      setMediaError(null);
      if (draftRef.current.media.length >= LIMITS.files) {
        setMediaError(`You can attach up to ${LIMITS.files} files.`);
        return;
      }
      let name = uri;
      try {
        const parsed = new URL(uri);
        const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
        name = last || parsed.hostname;
      } catch (e) {
        name = uri;
      }
      const item = {
        id: DP.uid('m'),
        name,
        mimeType,
        size: null,
        kind: 'url',
        uri,
        previewUrl: /^(image|video|audio)\//.test(mimeType) || mimeType === 'application/pdf' ? uri : null,
      };
      setDraft((d) => ({...d, media: [...d.media, item]}));
      setUrlDialog(null);
    };

    const removeFile = (id) => {
      const removed = draft.media.find((m) => m.id === id);
      if (removed && removed.previewUrl && removed.previewUrl.startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl);
      if (previewId === id) setPreviewId(null);
      updateDraft({media: draft.media.filter((m) => m.id !== id)});
      setMediaError(null);
    };

    const findRecording = (redacted) => {
      const want = DP.stableStringify(redacted);
      const match = examples.find((e) => e.recorded && DP.stableStringify(e.recorded.request) === want);
      return match ? match.recorded.response : null;
    };

    async function runDraft(target) {
      const source = {...(target || draftRef.current), mediaResolution: settings.mediaResolution};
      const blocking = DP.blockingIssue(source);
      if (blocking) {
        setJsonOpen(false);
        setShowIssues(true);
        const first = source.questions.find((q) => Object.keys(DP.questionIssues(q, source.questions)).length);
        // Same order as blockingIssue: the input first, then each question.
        if (source.questions.length && !source.text.trim() && !source.media.length) {
          setFocusTarget('state-text');
        } else if (first) {
          setOpenId(first.uid);
          const issues = DP.questionIssues(first, source.questions);
          const field = issues.key ? `${first.uid}-key` : issues.instructions ? `${first.uid}-instructions` : null;
          if (field) setFocusTarget(field);
        }
        return;
      }
      setShowIssues(false);
      if (connRef.current.status === 'checking' && healthRef.current) await healthRef.current;
      // A run that would call the Decisions API needs a key: always in the
      // applet, and in a copy with no backend unless it replays a recording.
      const key = apiKeyRef.current;
      if (IN_AISTUDIO && !key) {
        const hasSelected = await refreshAiStudioKey();
        if (!hasSelected) {
          await openKeyPrompt(true);
          return;
        }
      }
      const direct = DIRECT || IN_AISTUDIO || !!key;
      const replay = !direct && connRef.current.status === 'offline';
      if (
        !IN_AISTUDIO &&
        !key &&
        (DIRECT || (replay && !findRecording(DP.buildRequest({...source, model: modelId}, {redact: true}))))
      ) {
        setKeyDialog({pending: true});
        return;
      }
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const id = ++runSeq.current;
      const sigs = signatures(source, modelId);
      const keyByUid = Object.fromEntries(source.questions.map((q) => [q.uid, q.key.trim()]));
      setRun((prev) => ({
        id,
        status: 'running',
        sigs: prev && prev.response ? prev.sigs : sigs,
        keyByUid: prev && prev.response ? prev.keyByUid : keyByUid,
        response: prev ? prev.response : null,
        modelId,
      }));

      // Runs started while sample files are still loading wait for them.
      let ready = source;
      if (ready.media.some((m) => m.kind === 'binary' && !m.data && m.src)) {
        const media = await loadExampleMedia(ready.media);
        ready = {...ready, media};
      }
      if (id !== runSeq.current) return;
      const request = DP.buildRequest({...ready, model: modelId});
      let response = null;
      let recorded = false;
      let error = null;
      if (replay) {
        response = findRecording(DP.buildRequest({...ready, model: modelId}, {redact: true}));
        recorded = !!response;
      } else if (ready.media.some((m) => m.kind === 'binary' && !m.data)) {
        error = {title: "Attachments didn't load", detail: 'Remove them and attach the files again.'};
      } else {
        const safetyRequest = DP.buildSafetyRequest(request);
        const safetyBody = JSON.stringify(safetyRequest);
        const body = JSON.stringify(request);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, 90000);
        try {
          if (body.length > LIMITS.requestBytes * 1.4) throw new RangeError('too large');
          const safetyPromise = direct
            ? callDirect(safetyRequest, controller.signal, key)
            : callBackend(safetyBody, controller.signal);
          const decisionPromise = direct
            ? callDirect(request, controller.signal, key)
            : callBackend(body, controller.signal);

          const [safetyRes, r] = await Promise.all([safetyPromise, decisionPromise]);
          if (!safetyRes.ok) {
            const message =
              (safetyRes.payload && safetyRes.payload.error && safetyRes.payload.error.message) ||
              `The server returned HTTP ${safetyRes.status}.`;
            const badKey = safetyRes.status === 400 && /api key/i.test(message);
            if (direct && (badKey || [401, 403, 404].includes(safetyRes.status))) {
              error = badKey
                ? {title: "That API key didn't work", detail: message, linkKey: true}
                : {
                    title: "This API key couldn't access the Decisions API",
                    detail: `Link a valid Gemini API key and try again. (${message})`,
                    linkKey: true,
                  };
            } else {
              error = {
                title: safetyRes.status === 401 ? 'Access denied' : `${modelLabelFor(modelId)} couldn't answer`,
                detail: message,
              };
            }
          } else if (DP.isUnsafeDecision(safetyRes.payload)) {
            error = {
              title: 'Gemini Decisions API has flagged this an unsafe prompt',
              detail: '',
              unsafe: true,
            };
          } else {
            if (r.ok) response = r.payload;
            else {
              const message = (r.payload.error && r.payload.error.message) || `The server returned HTTP ${r.status}.`;
              const badKey = r.status === 400 && /api key/i.test(message);
              if (direct && (badKey || [401, 403, 404].includes(r.status))) {
                error = badKey
                  ? {title: "That API key didn't work", detail: message, linkKey: true}
                  : {
                      title: "This API key couldn't access the Decisions API",
                      detail: `Link a valid Gemini API key and try again. (${message})`,
                      linkKey: true,
                    };
              } else {
                error = {title: r.status === 401 ? 'Access denied' : `${modelLabelFor(modelId)} couldn't answer`, detail: message};
              }
            }
          }
        } catch (e) {
          if (controller.signal.aborted && !timedOut) return;
          error =
            e instanceof RangeError
              ? {title: `This request is over ${DP.formatBytes(LIMITS.requestBytes)}`, detail: 'Remove an attachment or use smaller files.'}
              : timedOut
                ? {title: 'The run took too long', detail: 'The backend may be overloaded. Try again in a moment.'}
                : direct
                  ? {title: "Couldn't reach the Decisions API", detail: 'Check your connection, then try again.'}
                  : {title: "Couldn't reach the server", detail: 'Check that server.py is still running, then try again.'};
        } finally {
          clearTimeout(timer);
        }
        // If the API can't be used, an unedited example can still show its recording.
        if (error && !error.unsafe && !direct && connRef.current.status === 'unavailable') {
          response = findRecording(DP.buildRequest({...source, model: modelId}, {redact: true}));
          if (response) {
            recorded = true;
            error = null;
          }
        }
      }
      if (id !== runSeq.current) return;
      abortRef.current = null;
      if (error) {
        setJsonOpen(false);
        setRun((prev) => ({
          ...(prev || {}),
          id,
          status: 'error',
          error,
          response: error.unsafe ? null : prev ? prev.response : null,
          sigs: prev && prev.response && !error.unsafe ? prev.sigs : sigs,
        }));
        return;
      }
      setRun({id, status: 'done', sigs, keyByUid, response, recorded, modelId});
    }

    function modelLabelFor(id) {
      return (models.find((m) => m.id === id) || {label: id}).label;
    }

    const copy = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        setToast('Copied to clipboard');
      } catch (e) {
        setToast("Couldn't copy. Select the text and copy it instead.");
      }
    };

    // A file dropped outside the input card shouldn't navigate away.
    useEffect(() => {
      const block = (e) => {
        if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
      };
      window.addEventListener('dragover', block);
      window.addEventListener('drop', block);
      return () => {
        window.removeEventListener('dragover', block);
        window.removeEventListener('drop', block);
      };
    }, []);

    // ⌘/Ctrl + Enter runs from anywhere in the workspace.
    const runRef = useRef(runDraft);
    runRef.current = runDraft;
    useEffect(() => {
      const onKey = (e) => {
        if (document.querySelector('.overlay')) return; // Not behind a dialog.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing && routeFromHash() === 'work') {
          e.preventDefault();
          runRef.current();
        }
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, []);

    // ------------------------------------------------------------ Render

    const answers = run && run.response ? run.response.answers : {};
    const errors = run && run.response && run.response.errors ? run.response.errors : {};
    const loading = !!run && run.status === 'running';

    const hasAnswers = !!run && (!!run.response || run.status === 'error');
    const apiResponse = run && run.response ? (({round_trip_ms, ...rest}) => rest)(run.response) : null;

    return html`<div class="app">
      <${TopBar}
        view=${view}
        onHome=${goHome}
        codeOpen=${codeOpen}
        onCode=${() => setCodeOpen(!codeOpen)}
        keyLinked=${IN_AISTUDIO ? aiStudioKeyLinked : !!apiKey}
        onKey=${() => openKeyPrompt(false)}
        theme=${theme}
        onTheme=${() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      />
      ${view === 'home'
        ? html`<${Home}
            examples=${examples}
            onStart=${startBlank}
            onOpen=${openExample}
          />`
        : html`<div class="workspace">
            <div class="work-col">
              <main class="page page-work">
                <div class="work-inner">
                <header class="work-header">
                  <h1 class="work-header-title">Add questions you'd like decisions on</h1>
                  <p class="work-header-desc">
                    Define boolean, choice, and score questions below, then run them against the input in the prompt bar. Every question is evaluated in a single API call with calibrated probabilities.
                  </p>
                </header>
                <hr class="work-divider" />
                <div class="q-head">
                  <div class="q-head-text">
                    <h2 class="q-title">Questions · ${draft.questions.length}</h2>
                  </div>
                  <span class="spacer"></span>
                  ${hasAnswers &&
                  html`<button class="ghost-btn muted" onClick=${clearAnswers} title="Remove the answers from every question">
                    <${Icon} name="eraser" size=${14} /> Clear answers
                  </button>`}
                </div>
                <div class="q-chips">
                  ${TYPE_ORDER.map(
                    (t) => html`<button key=${t} class=${`filter-chip kind-chip tone-${TYPES[t].tone}`} onClick=${() => addQuestion(t)} disabled=${draft.questions.length >= LIMITS.questions}>
                      <${Icon} name="plus" size=${14} /> ${TYPES[t].label}
                    </button>`,
                  )}
                  <span class="spacer"></span>
                  ${draft.questions.length > 0 &&
                  html`<button class="ghost-btn muted" onClick=${clearQuestions} title="Remove all questions">
                    Remove all
                  </button>`}
                </div>
                <div class="questions q-panel">
                  ${draft.questions.map((q) => {
                    const issues = showIssues ? DP.questionIssues(q, draft.questions) : {};
                    const key = run && run.keyByUid ? run.keyByUid[q.uid] : undefined;
                    return html`<${QuestionCard}
                      key=${q.uid}
                      question=${q}
                      open=${openId === q.uid}
                      issues=${issues}
                      flagged=${Object.keys(issues).length > 0}
                      answer=${key && answers[key] && (!answers[key].type || answers[key].type === q.type) ? answers[key] : undefined}
                      error=${key ? errors[key] : undefined}
                      stale=${isStale(q)}
                      loading=${loading}
                      onToggle=${() => setOpenId(openId === q.uid ? null : q.uid)}
                      onChange=${(patch, opts) => setQuestion(q.uid, patch, opts)}
                      onType=${(t) => changeType(q.uid, t)}
                      onRemove=${() => removeQuestion(q.uid)}
                    />`;
                  })}
                  ${draft.questions.length === 0 &&
                  html`<div class="empty-questions">
                    Add a boolean, choice or score question. They're all answered in a single call.
                  </div>`}
                </div>
                ${run &&
                run.status === 'error' &&
                html`<div class="error-panel" role="alert">
                  <b>${run.error.title}</b>${run.error.detail ? html`<p>${run.error.detail}</p>` : null}
                  ${run.error.linkKey &&
                  html`<button class="btn btn-sm" style="margin-top: 10px" onClick=${() => openKeyPrompt(true)}>
                    <${Icon} name="key-round" size=${14} /> Link a different key
                  </button>`}
                </div>`}
                </div>
              </main>
              <${Composer}
                text=${draft.text}
                media=${draft.media}
                onText=${(text) => updateDraft({text})}
                onAddFiles=${addFiles}
                onOpenUrl=${(kind) => setUrlDialog({kind})}
                onRemoveFile=${removeFile}
                onPreview=${setPreviewId}
                error=${mediaError || (showIssues && !draft.text.trim() && !draft.media.length ? 'Add some input to decide on.' : null)}
                running=${loading}
                onRun=${() => runDraft()}
                onJson=${() => setJsonOpen(true)}
                status=${html`<${RunStatus}
                  run=${run}
                  stale=${anyStale}
                  issue=${issue}
                  showIssue=${showIssues}
                  modelLabel=${modelLabel}
                  hasMedia=${draft.media.some(DP.takesResolution)}
                  resolution=${settings.mediaResolution}
                  onResolution=${(mediaResolution) => setSettings({...settings, mediaResolution})}
                />`}
              />
            </div>
          </div>`}
      ${codeOpen &&
      html`<${CodeDialog} request=${codeRequest} onCopy=${copy} onClose=${() => setCodeOpen(false)} />`}
      ${urlDialog &&
      html`<${UrlDialog} initialKind=${urlDialog.kind} onAdd=${addUrl} onClose=${() => setUrlDialog(null)} />`}
      ${jsonOpen &&
      html`<${JsonDialog}
        request=${codeRequest}
        response=${apiResponse}
        running=${loading}
        runOff=${loading || (!draft.text.trim() && !draft.media.length)}
        onRun=${() => runDraft()}
        onCopy=${copy}
        onClose=${() => setJsonOpen(false)}
      />`}
      ${keyDialog &&
      html`<${KeyDialog}
        apiKey=${apiKey}
        onClose=${() => setKeyDialog(null)}
        onSave=${(next) => {
          const pending = keyDialog.pending;
          apiKeyRef.current = next;
          setApiKey(next);
          setKeyDialog(null);
          setToast(next ? 'API key linked' : 'API key unlinked');
          if (next && pending) {
            runRef.current();
          } else if (next && run && run.status === 'error' && run.error && run.error.linkKey) {
            setRun(null);
          }
        }}
      />`}
      ${previewItem && html`<${MediaPreview} key=${previewItem.id} item=${previewItem} onClose=${() => setPreviewId(null)} />`}
      ${toast && html`<div class="toast" role="status"><${Icon} name="check" size=${16} />${toast}</div>`}
    </div>`;
  }

  render(html`<${App} />`, document.getElementById('root'));
})();
