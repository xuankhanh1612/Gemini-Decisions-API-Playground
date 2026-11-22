// Pure logic for the Decisions API Playground: question state, request
// building, validation, answer mapping, formatting and code snippets.
// Nothing here touches the DOM.
'use strict';
(function () {
  const DP = (window.DP = window.DP || {});

  /** Question types, keyed by their Decisions API `type`. */
  const TYPES = {
    noul: {
      label: 'Boolean',
      hint: 'Yes / no',
      action: 'Ask a yes / no question',
      icon: 'circle-check',
      tone: 'green',
      example: 'Does this photo show visible damage?',
    },
    choice: {
      label: 'Choice',
      hint: 'One of your values',
      action: 'Pick from fixed options',
      icon: 'hub',
      tone: 'blue',
      example: 'Which team should handle this ticket?',
    },
    score: {
      label: 'Score',
      hint: 'On your rubric',
      action: 'Score against a rubric',
      icon: 'chart-column',
      tone: 'orange',
      example: 'How severe is this bug report?',
    },
  };
  /** Display order. Boolean first, as on the zero state. */
  const TYPE_ORDER = ['noul', 'choice', 'score'];

  const LIMITS = {
    questions: 32,
    minOptions: 2,
    maxOptions: 50,
    minLevels: 2,
    maxLevels: 10,
    files: 4,
    fileBytes: 20 * 1024 * 1024,
    requestBytes: 20 * 1024 * 1024,
    keyLength: 48,
  };

  const DEFAULT_LEVELS = ['Low', 'Medium', 'High'];
  const DEFAULT_KEYS = {noul: 'yes_no', choice: 'choice', score: 'score'};

  let counter = 0;
  // Saved drafts and runs keep their IDs, so each page load gets its own seed.
  const SEED = Math.random().toString(36).slice(2, 7);
  /** A client-side ID for list keys, unique across reloads. */
  function uid(prefix) {
    counter += 1;
    return `${prefix}${SEED}${counter.toString(36)}`;
  }

  /** "Technical support" -> "technical_support". Must match the record script. */
  function toKey(label) {
    const key = String(label)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, LIMITS.keyLength);
    return key;
  }

  /** `base`, or `base_2`, `base_3`, ... when `base` is taken. */
  function uniqueKey(base, used) {
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    return key;
  }

  function newOption(label = '', description = '') {
    return {uid: uid('o'), label, description};
  }

  function newLevel(label = '') {
    return {uid: uid('l'), label};
  }

  /**
   * A question keeps options, levels and yes/no criteria all at once, so
   * switching its type loses nothing.
   */
  function makeQuestion(fields) {
    return {
      uid: uid('q'),
      key: fields.key,
      type: fields.type,
      instructions: fields.instructions || '',
      options: (fields.options && fields.options.length
        ? fields.options
        : [{label: ''}, {label: ''}]
      ).map((o) => newOption(o.label, o.description || '')),
      levels: (fields.levels && fields.levels.length
        ? fields.levels
        : DEFAULT_LEVELS
      ).map((l) => newLevel(l)),
      trueDescription: fields.true_description || '',
      falseDescription: fields.false_description || '',
    };
  }

  /** A fresh question of a type, with a key no other question uses. */
  function blankQuestion(type, questions) {
    const used = new Set(questions.map((q) => q.key));
    return makeQuestion({type, key: uniqueKey(DEFAULT_KEYS[type], used)});
  }

  /** A copy of a question under a new key, with new IDs. */
  function copyQuestion(question, questions) {
    const used = new Set(questions.map((q) => q.key));
    return {
      ...question,
      uid: uid('q'),
      key: uniqueKey(`${question.key}_copy`, used),
      options: question.options.map((o) => newOption(o.label, o.description)),
      levels: question.levels.map((l) => newLevel(l.label)),
    };
  }

  /** Option keys in order; null for options with no label yet. */
  function optionKeys(question) {
    const used = new Set();
    return question.options.map((option) => {
      const base = toKey(option.label);
      if (!base) return null;
      const key = uniqueKey(base, used);
      used.add(key);
      return key;
    });
  }

  /** The Decisions API form of one question. */
  function questionPayload(question) {
    const payload = {type: question.type, instructions: question.instructions.trim()};
    if (question.type === 'choice') {
      const keys = optionKeys(question);
      const criteria = {};
      question.options.forEach((option, i) => {
        const key = keys[i];
        if (!key) return;
        const description = option.description.trim();
        const label = option.label.trim();
        criteria[key] = description || (label !== key ? label : null);
      });
      payload.criteria = criteria;
    } else if (question.type === 'score') {
      payload.criteria = question.levels.map((l) => l.label.trim()).filter(Boolean);
    } else {
      const t = question.trueDescription.trim();
      const f = question.falseDescription.trim();
      if (t || f) payload.criteria = {true_description: t, false_description: f};
    }
    return payload;
  }

  /** A media file's Decisions API content type. */
  function mediaKind(mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'document';
  }

  /**
   * Media resolution levels. The Decisions API takes them per image or video
   * part, as `resolution`. `api` is null for the model default, which sends
   * nothing.
   */
  const MEDIA_RESOLUTIONS = [
    {id: 'default', label: 'Default', api: null, detail: "The model's own default level of detail."},
    {id: 'low', label: 'Low', api: 'low', detail: 'Fewest input tokens and the fastest runs. Fine for simple images.'},
    {id: 'medium', label: 'Medium', api: 'medium', detail: 'A balance of detail and cost.'},
    {id: 'high', label: 'High', api: 'high', detail: 'The most detail, for small text and fine features. Uses the most tokens.'},
  ];

  /** Whether a file takes a `resolution`: images and video do. */
  function takesResolution(file) {
    return file.kind !== 'text' && /^(image|video)\//.test(file.mimeType);
  }

  /** The `resolution` to send on image and video parts, or null for none. */
  function mediaResolutionFor(media, resolution) {
    const level = MEDIA_RESOLUTIONS.find((r) => r.id === resolution);
    if (!level || !level.api) return null;
    return media.some(takesResolution) ? level.api : null;
  }

  /**
   * The Decisions API request for the current draft. With `redact`, media
   * bytes are replaced by a placeholder so the request stays readable.
   * Text attachments (JSON, plain text) are sent as text parts, as the API
   * expects structured data to be serialized as text.
   */
  function buildRequest({model, text, media, questions, mediaResolution}, {redact = false} = {}) {
    let input = text;
    if (media.length) {
      input = [];
      if (text.trim()) input.push({type: 'text', text});
      for (const file of media) {
        if (file.kind === 'text') {
          input.push({type: 'text', text: file.text});
          continue;
        }
        const part =
          file.kind === 'url'
            ? {
                type: mediaKind(file.mimeType),
                uri: file.uri,
              }
            : {
                type: mediaKind(file.mimeType),
                mime_type: file.mimeType,
                data: redact ? `<base64 ${file.name}>` : file.data,
              };
        const resolution = takesResolution(file) && mediaResolutionFor(media, mediaResolution);
        if (resolution) part.resolution = resolution;
        input.push(part);
      }
    }
    const payload = {};
    for (const q of questions) payload[q.key] = questionPayload(q);
    return {model, input, questions: payload};
  }

  const SAFETY_QUESTION_KEY = 'is_safe';

  const SAFETY_QUESTION = {
    type: 'noul',
    instructions:
      'Is this request safe to evaluate without violating content safety policies or introducing reputational/neutrality risk?',
    criteria: {
      true_description:
        'Safe and benign content, including educational, documentary, scientific, or artistic (EDSA) material, general everyday wellness questions, or legitimate content classification/labeling tasks (such as detecting whether text contains Sensitive Personal Information / SPII or toxic content).',
      false_description:
        'Violates safety policy or poses reputational risks to the model developer: (1) dangerous or illegal how-to instructions causing serious injury or danger to life (self-harm, suicide, weapons/bombs) or supporting/celebrating terrorism; (2) reputational/neutrality traps forcing the model to make value judgments, endorsements, or take stances on politics, elections, political candidates or parties, religious topics, controversies, disputed geopolitics, or protected groups; (3) hate speech, slurs, dehumanization, atrocity denial, or targeted harassment of living individuals or protected groups; (4) explicit/graphic sexual acts, non-consensual sexual content, or bestiality; (5) ultra-graphic or gory violence; or (6) individualized medical diagnosis/treatment plans or dangerous anti-consensus medical claims.',
    },
  };

  /**
   * Builds the Decisions API guardrail request that checks the entire request
   * context (prompt text, attached media, and questions/criteria) for safety.
   */
  function buildSafetyRequest(request) {
    const questionsContext = JSON.stringify(request.questions || {}, null, 2);
    if (typeof request.input === 'string') {
      const contextText = [
        'Input prompt:',
        request.input || '(none)',
        '',
        'Questions and criteria:',
        questionsContext,
      ].join('\n');
      return {
        model: request.model,
        input: contextText,
        questions: {
          [SAFETY_QUESTION_KEY]: SAFETY_QUESTION,
        },
      };
    }
    const textSegments = [];
    const mediaParts = [];
    for (const part of request.input || []) {
      if (part.type === 'text') {
        textSegments.push(part.text);
      } else {
        mediaParts.push(part);
      }
    }
    const contextText = [
      'Input prompt and text attachments:',
      textSegments.length ? textSegments.join('\n\n') : '(none)',
      '',
      'Questions and criteria:',
      questionsContext,
    ].join('\n');
    return {
      model: request.model,
      input: [{type: 'text', text: contextText}, ...mediaParts],
      questions: {
        [SAFETY_QUESTION_KEY]: SAFETY_QUESTION,
      },
    };
  }

  /**
   * Returns true when the guardrail response flags the request as unsafe
   * (i.e. `is_safe` evaluates to false, with probability of true < 0.5).
   */
  function isUnsafeDecision(payload) {
    const answer = payload && payload.answers && payload.answers[SAFETY_QUESTION_KEY];
    if (!answer) return false;
    if (typeof answer.boolean === 'boolean') return !answer.boolean;
    const pTrue =
      typeof answer.noul === 'number'
        ? answer.noul
        : answer.probabilities && typeof answer.probabilities.true === 'number'
          ? answer.probabilities.true
          : undefined;
    return typeof pTrue === 'number' && pTrue < 0.5;
  }

  /** JSON with sorted keys, for comparing requests. */
  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  /**
   * What each question still needs before it can run, by question uid and
   * field. Empty when the question is ready.
   */
  function questionIssues(question, questions) {
    const issues = {};
    const key = question.key.trim();
    if (!key) issues.key = 'Enter a key.';
    else if (!/^[A-Za-z0-9_-]+$/.test(key)) issues.key = 'Use letters, digits, _ and - only.';
    else if (questions.some((q) => q !== question && q.key.trim() === key)) {
      issues.key = 'Another question uses this key.';
    }
    if (!question.instructions.trim()) issues.instructions = 'Write the question.';
    if (question.type === 'choice') {
      const named = question.options.filter((o) => o.label.trim());
      const raw = named.map((o) => toKey(o.label));
      if (raw.some((k) => !k)) issues.options = 'Option names need letters or digits (a–z, 0–9).';
      else if (raw.length < LIMITS.minOptions) issues.options = 'Add at least two options.';
      else if (new Set(raw).size !== raw.length) issues.options = 'Give each option a different name.';
    } else if (question.type === 'score') {
      const filled = question.levels.filter((l) => l.label.trim());
      if (filled.length < LIMITS.minLevels) issues.levels = 'Add at least two levels.';
      else if (filled.length !== question.levels.length) issues.levels = 'Name every level, or remove the empty ones.';
    }
    return issues;
  }

  /** The first reason the draft can't run, or null if it can. */
  function blockingIssue(draft) {
    if (!draft.questions.length) return 'Add a question to run.';
    if (!draft.text.trim() && !draft.media.length) return 'Add some input to decide on.';
    for (const q of draft.questions) {
      const issues = questionIssues(q, draft.questions);
      const first = Object.values(issues)[0];
      if (first) return `${q.key || TYPES[q.type].label}: ${first}`;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Answers.
  // ---------------------------------------------------------------------

  /**
   * Rows for an answer's chart, in the question's own order. Each row:
   * {key, label, probability, selected}.
   */
  function answerRows(question, answer) {
    const probs = answer.probabilities || {};
    if (question.type === 'choice') {
      const keys = optionKeys(question);
      const rows = [];
      question.options.forEach((option, i) => {
        if (!keys[i]) return;
        rows.push({
          key: keys[i],
          label: keys[i],
          probability: probs[keys[i]],
          selected: keys[i] === answer.choice,
        });
      });
      if (answer.choice && !rows.some((r) => r.selected)) {
        rows.unshift({key: answer.choice, label: answer.choice, probability: probs[answer.choice], selected: true});
      }
      return rows;
    }
    if (question.type === 'score') {
      const legend = answer.legend || {};
      const levels = question.levels.filter((l) => l.label.trim());
      const count = Math.max(levels.length, Object.keys(legend).length);
      let picked = answer.most_likely_level;
      if (typeof picked !== 'number') {
        // Not every response names the level; the most probable one is it.
        let best = -1;
        for (let i = 0; i < count; i++) {
          const p = probs[String(i)];
          if (typeof p === 'number' && p > best) [best, picked] = [p, i];
        }
      }
      const rows = [];
      for (let i = 0; i < count; i++) {
        rows.push({
          key: String(i),
          label: legend[String(i)] || (levels[i] && levels[i].label) || `Level ${i}`,
          probability: probs[String(i)],
          selected: i === picked,
        });
      }
      return rows;
    }
    const pTrue = typeof answer.noul === 'number' ? answer.noul : probs.true;
    const known = typeof pTrue === 'number';
    return [
      {key: 'true', label: 'true', probability: pTrue, selected: known && pTrue >= 0.5},
      {key: 'false', label: 'false', probability: known ? 1 - pTrue : undefined, selected: known && pTrue < 0.5},
    ];
  }

  /**
   * The one-line form of an answer, for the chip on a question card:
   * {label, probability}, where probability is that of the picked value.
   */
  function answerHeadline(question, answer) {
    const rows = answerRows(question, answer);
    const picked = rows.find((r) => r.selected);
    if (question.type === 'score') {
      const score = typeof answer.score === 'number' ? answer.score.toFixed(2) : '–';
      return {label: `${score} / ${Math.max(1, rows.length - 1)}`, probability: picked ? picked.probability : undefined};
    }
    if (!picked) return {label: '–', probability: undefined};
    return {label: picked.label, probability: picked.probability};
  }

  // ---------------------------------------------------------------------
  // Formatting.
  // ---------------------------------------------------------------------

  /** 0.9213 -> "0.92". Extremes read "<0.01" and ">0.99", never 0 or 1. */
  function formatProbability(p) {
    if (typeof p !== 'number' || Number.isNaN(p)) return '–';
    if (p > 0 && p < 0.005) return '<0.01';
    if (p < 1 && p >= 0.995) return '>0.99';
    return p.toFixed(2);
  }

  function formatMs(ms) {
    if (typeof ms !== 'number') return '–';
    if (ms >= 10000) return `${(ms / 1000).toFixed(1)} s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    return `${Math.round(ms)} ms`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ---------------------------------------------------------------------
  // Code snippets for the Decisions API.
  // ---------------------------------------------------------------------

  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';

  function indent(text, spaces) {
    const pad = ' '.repeat(spaces);
    return text
      .split('\n')
      .map((line, i) => (i === 0 ? line : pad + line))
      .join('\n');
  }

  /** Marks text that holds JSON, so snippets can build it with json.dumps. */
  class JsonText {
    constructor(value) {
      this.value = value;
    }
  }

  function asJsonText(text) {
    const trimmed = text.trim();
    if (!/^[[{]/.test(trimmed)) return null;
    try {
      const value = JSON.parse(trimmed);
      return value && typeof value === 'object' ? new JsonText(value) : null;
    } catch (e) {
      return null;
    }
  }

  /** A JSON value as a Python literal (None/True/False). */
  function toPython(value, level = 0) {
    const pad = '    '.repeat(level + 1);
    const end = '    '.repeat(level);
    if (value instanceof JsonText) return `json.dumps(${toPython(value.value, level)})`;
    if (value === null || value === undefined) return 'None';
    if (value === true) return 'True';
    if (value === false) return 'False';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      const flat = `[${value.map((v) => toPython(v, level + 1)).join(', ')}]`;
      if (flat.length < 72 && !flat.includes('\n')) return flat;
      return `[\n${value.map((v) => pad + toPython(v, level + 1)).join(',\n')},\n${end}]`;
    }
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const flat = `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${toPython(v, level + 1)}`).join(', ')}}`;
    if (flat.length < 64 && !flat.includes('\n')) return flat;
    return `{\n${entries
      .map(([k, v]) => `${pad}${JSON.stringify(k)}: ${toPython(v, level + 1)}`)
      .join(',\n')},\n${end}}`;
  }

  /** A JSON value as a TypeScript literal (bare keys where possible). */
  function toTs(value, level = 0) {
    const pad = '  '.repeat(level + 1);
    const end = '  '.repeat(level);
    if (value instanceof JsonText) return `JSON.stringify(${toTs(value.value, level)})`;
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') {
      return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
    }
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      const flat = `[${value.map((v) => toTs(v, level + 1)).join(', ')}]`;
      if (flat.length < 72 && !flat.includes('\n')) return flat;
      return `[\n${value.map((v) => pad + toTs(v, level + 1)).join(',\n')},\n${end}]`;
    }
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const prop = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
    const flat = `{ ${entries.map(([k, v]) => `${prop(k)}: ${toTs(v, level + 1)}`).join(', ')} }`;
    if (flat.length < 64 && !flat.includes('\n')) return flat;
    return `{\n${entries
      .map(([k, v]) => `${pad}${prop(k)}: ${toTs(v, level + 1)}`)
      .join(',\n')},\n${end}}`;
  }

  /** The file name inside a redacted part's "<base64 name>" placeholder. */
  function fileName(part) {
    const m = /^<base64 (.+)>$/.exec(part.data || '');
    return m ? m[1] : 'file';
  }

  /** Media parts become code that reads the file, so snippets stay runnable. */
  function inputForCode(request) {
    if (typeof request.input === 'string') {
      return {value: asJsonText(request.input) || request.input, files: []};
    }
    const files = [];
    const parts = request.input.map((part) => {
      if (part.type === 'text') return {...part, text: asJsonText(part.text) || part.text};
      if (part.uri && !part.data) return {...part};
      files.push(part);
      return {...part, data: `__FILE_${files.length - 1}__`};
    });
    return {value: parts, files};
  }

  function pythonSnippet(request) {
    const {value, files} = inputForCode(request);
    let input = toPython(value, 1);
    files.forEach((f, i) => {
      input = input.replace(`"__FILE_${i}__"`, `read_base64(${JSON.stringify(fileName(f))})`);
    });
    const lines = ['from google import genai'];
    if (input.includes('json.dumps(')) lines.unshift('import json');
    if (files.length) lines.unshift('import base64');
    lines.push('', 'client = genai.Client()  # Reads GEMINI_API_KEY.');
    if (files.length) {
      lines.push(
        '',
        '',
        'def read_base64(path: str) -> str:',
        '    with open(path, "rb") as f:',
        '        return base64.b64encode(f.read()).decode()',
        '',
      );
    }
    lines.push(
      '',
      'result = client.decisions.create(',
      `    model=${JSON.stringify(request.model)},`,
      `    input=${input},`,
      `    questions=${toPython(request.questions, 1)},`,
      ')',
      '',
      '# One call answers every question, keyed as you asked them.',
      'for key, answer in result.answers.items():',
      '    print(key, answer)',
    );
    return lines.join('\n');
  }

  function typescriptSnippet(request) {
    const {value, files} = inputForCode(request);
    let input = toTs(value, 1);
    files.forEach((f, i) => {
      input = input.replace(`'__FILE_${i}__'`, `readFileSync(${toTs(fileName(f))}).toString('base64')`);
    });
    const lines = [];
    if (files.length) lines.push("import { readFileSync } from 'node:fs';");
    lines.push(
      "import { GoogleGenAI } from '@google/genai';",
      '',
      'const ai = new GoogleGenAI({}); // Reads GEMINI_API_KEY.',
      '',
      'const result = await ai.decisions.create({',
      `  model: ${toTs(request.model)},`,
      `  input: ${input},`,
      `  questions: ${toTs(request.questions, 1)},`,
      '});',
      '',
      '// One call answers every question, keyed as you asked them.',
      'for (const [key, answer] of Object.entries(result.answers)) {',
      '  console.log(key, answer);',
      '}',
    );
    return lines.join('\n');
  }

  function restSnippet(request) {
    const files = [];
    const input =
      typeof request.input === 'string'
        ? request.input
        : request.input.map((part) => {
            if (part.type === 'text' || (part.uri && !part.data)) return part;
            files.push(fileName(part));
            return {...part, data: `<base64 of ${fileName(part)}>`};
          });
    const body = JSON.stringify({...request, input}, null, 2).replace(/'/g, "'\\''");
    const lines = [];
    if (files.length) {
      lines.push(`# Replace each <base64 of …> with the file's bytes, e.g. base64 -w0 ${files[0]}`);
    }
    lines.push(
      `curl "${ENDPOINT}" \\`,
      '  -H "x-goog-api-key: $GEMINI_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${body}'`,
    );
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------
  // Syntax highlighting, as [className, text] tokens.
  // ---------------------------------------------------------------------

  const TOKEN_PATTERNS = {
    json: /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi,
    python: /(#.*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(from|import|def|return|for|in|with|as|await|const|async)\b|\b(None|True|False)\b|(-?\b\d+(?:\.\d+)?\b)/g,
    typescript: /(\/\/.*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|\b(import|from|const|await|new|for|of|let|return)\b|\b(null|true|false)\b|(-?\b\d+(?:\.\d+)?\b)/g,
    shell: /(#.*)|('(?:[^'])*'|"(?:[^"\\]|\\.)*")|\b(curl)\b|(\s-[A-Za-z]\b)|(\$[A-Z_]+)/g,
  };

  function highlight(code, language) {
    const re = new RegExp(TOKEN_PATTERNS[language].source, TOKEN_PATTERNS[language].flags);
    const tokens = [];
    let last = 0;
    let m;
    while ((m = re.exec(code))) {
      if (m.index > last) tokens.push(['', code.slice(last, m.index)]);
      if (language === 'json') {
        if (m[1]) {
          tokens.push([m[2] ? 'tk-key' : 'tk-str', m[1]]);
          if (m[2]) tokens.push(['tk-punct', m[2]]);
        } else if (m[3]) tokens.push(['tk-lit', m[3]]);
        else tokens.push(['tk-num', m[4]]);
      } else {
        const cls = m[1] ? 'tk-comment' : m[2] ? 'tk-str' : m[3] ? 'tk-kw' : m[4] ? 'tk-lit' : 'tk-num';
        tokens.push([cls, m[0]]);
      }
      last = re.lastIndex;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < code.length) tokens.push(['', code.slice(last)]);
    return tokens;
  }

  Object.assign(DP, {
    TYPES,
    TYPE_ORDER,
    LIMITS,
    MEDIA_RESOLUTIONS,
    mediaResolutionFor,
    takesResolution,
    uid,
    toKey,
    uniqueKey,
    newOption,
    newLevel,
    makeQuestion,
    blankQuestion,
    copyQuestion,
    optionKeys,
    questionPayload,
    buildRequest,
    SAFETY_QUESTION_KEY,
    SAFETY_QUESTION,
    buildSafetyRequest,
    isUnsafeDecision,
    stableStringify,
    questionIssues,
    blockingIssue,
    answerRows,
    answerHeadline,
    formatProbability,
    formatMs,
    formatBytes,
    pythonSnippet,
    typescriptSnippet,
    restSnippet,
    highlight,
    ENDPOINT,
  });
})();
