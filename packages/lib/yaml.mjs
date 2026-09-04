/**
 * Minimal YAML parser/serializer — no external dependencies.
 *
 * Covers the subset the recipe format actually uses:
 *
 *   - block mappings, nested to any depth (`engines.vllm.args` is three deep);
 *   - block sequences, including sequences of mappings;
 *   - block scalars: `|`, `|-`, `|+`, `>`, `>-`, `>+` (recipe v1 `command:`
 *     templates are literal blocks, v2 `args:` are folded ones);
 *   - flow collections `{}` / `[]`, quoted and unquoted scalars, comments;
 *   - `key: value` where the value itself contains a colon
 *     (`PYTORCH_CUDA_ALLOC_CONF: expandable_segments:True`).
 *
 * It is deliberately not a full YAML implementation: no anchors, aliases,
 * tags, multi-document streams or complex keys. Anything outside the subset
 * raises, rather than being silently mis-parsed — the round trip feeds the
 * published inventory, so a quiet wrong answer is worse than a loud failure.
 */

// ---------------------------------------------------------------------------
// Line scanner
// ---------------------------------------------------------------------------

/**
 * Split the document into significant lines, keeping the raw text of each so
 * block scalars can re-read their own indentation.
 */
function scanLines(text) {
  const out = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/\r$/, '');
    const indent = line.search(/\S/);
    if (indent === -1) {
      out.push({ raw: line, indent: -1, content: '', blank: true, lineNo: i + 1 });
      continue;
    }
    const content = line.slice(indent);
    out.push({
      raw: line,
      indent,
      content,
      blank: false,
      comment: content.startsWith('#'),
      lineNo: i + 1,
    });
  }
  return out;
}

function nextSignificant(lines, i) {
  while (i < lines.length && (lines[i].blank || lines[i].comment)) i++;
  return i;
}

function fail(line, message) {
  const where = line ? ` (line ${line.lineNo})` : '';
  throw new Error(`yaml: ${message}${where}`);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a JS value.
 */
export function parseYaml(text) {
  const source = String(text);
  const lines = scanLines(source);
  lines.finalNewline = source.endsWith('\n');
  const start = nextSignificant(lines, 0);
  if (start >= lines.length) return {};
  const [value] = parseBlock(lines, start, lines[start].indent);
  return value;
}

/** Parse a mapping or a sequence at `indent`, starting at line `i`. */
function parseBlock(lines, i, indent) {
  const line = lines[i];
  if (line.content === '-' || line.content.startsWith('- ')) {
    return parseSequence(lines, i, indent);
  }
  return parseMapping(lines, i, indent);
}

function parseMapping(lines, start, indent) {
  const result = {};
  let i = start;

  while (true) {
    i = nextSignificant(lines, i);
    if (i >= lines.length) break;
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) fail(line, 'unexpected indentation in mapping');
    if (line.content === '-' || line.content.startsWith('- ')) break;

    const split = splitKey(line.content);
    if (!split) fail(line, `expected "key: value", got ${JSON.stringify(line.content)}`);
    const { key, rest } = split;

    const header = matchBlockScalar(rest);
    if (header) {
      const [text, next] = readBlockScalar(lines, i + 1, indent, header);
      result[key] = text;
      i = next;
      continue;
    }

    if (rest === '') {
      const next = nextSignificant(lines, i + 1);
      if (next < lines.length && lines[next].indent > indent) {
        const [value, after] = parseBlock(lines, next, lines[next].indent);
        result[key] = value;
        i = after;
      } else {
        result[key] = null;
        i = i + 1;
      }
      continue;
    }

    result[key] = parseScalar(rest, line);
    i = i + 1;
  }

  return [result, i];
}

function parseSequence(lines, start, indent) {
  const items = [];
  let i = start;

  while (true) {
    i = nextSignificant(lines, i);
    if (i >= lines.length) break;
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) fail(line, 'unexpected indentation in sequence');
    if (line.content !== '-' && !line.content.startsWith('- ')) break;

    const rest = line.content === '-' ? '' : line.content.slice(2).trim();

    if (rest === '') {
      const next = nextSignificant(lines, i + 1);
      if (next < lines.length && lines[next].indent > indent) {
        const [value, after] = parseBlock(lines, next, lines[next].indent);
        items.push(value);
        i = after;
      } else {
        items.push(null);
        i = i + 1;
      }
      continue;
    }

    // `- key: value` starts a mapping whose first line lives on the dash line.
    // Re-present it as a normal line indented past the dash and parse a
    // mapping from there.
    if (splitKey(rest)) {
      const nested = lines.slice();
      nested[i] = { ...line, indent: indent + 2, content: rest };
      const [value, after] = parseMapping(nested, i, indent + 2);
      items.push(value);
      i = after;
      continue;
    }

    const header = matchBlockScalar(rest);
    if (header) {
      const [text, next] = readBlockScalar(lines, i + 1, indent, header);
      items.push(text);
      i = next;
      continue;
    }

    items.push(parseScalar(rest, line));
    i = i + 1;
  }

  return [items, i];
}

/**
 * Split `key: value`, honouring quoted keys and values that contain colons.
 * Returns null when the line is not a mapping entry.
 */
function splitKey(content) {
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && i > 0 && /\s/.test(content[i - 1])) return null;
    if (ch === ':' && (i + 1 === content.length || /\s/.test(content[i + 1]))) {
      const key = content.slice(0, i).trim();
      if (key === '') return null;
      return { key: unquote(key), rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

function unquote(value) {
  if (value.length >= 2) {
    if (value.startsWith('"') && value.endsWith('"')) {
      return value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/''/g, "'");
    }
  }
  return value;
}

// -- block scalars ----------------------------------------------------------

const BLOCK_SCALAR = /^([|>])([+-]?)(\d*)([+-]?)\s*(#.*)?$/;

function matchBlockScalar(rest) {
  const m = BLOCK_SCALAR.exec(rest);
  if (!m) return null;
  return {
    folded: m[1] === '>',
    chomp: m[2] || m[4] || '',
    explicitIndent: m[3] ? Number(m[3]) : 0,
  };
}

/**
 * Read the body of a block scalar. `parentIndent` is the indentation of the
 * key that introduced it; the body is every following line indented past it.
 */
function readBlockScalar(lines, start, parentIndent, header) {
  const body = [];
  let i = start;
  let bodyIndent = header.explicitIndent
    ? parentIndent + header.explicitIndent
    : 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.blank) {
      // A whitespace-only line still contributes whatever sits past the
      // block's indentation — YAML keeps those spaces.
      body.push(bodyIndent ? line.raw.slice(bodyIndent) : '');
      continue;
    }
    if (line.indent <= parentIndent) break;
    if (!bodyIndent) bodyIndent = line.indent;
    if (line.indent < bodyIndent) break;
    body.push(line.raw.slice(bodyIndent));
  }
  const atEndOfFile = i >= lines.length;

  // Trailing blank lines belong to the chomping rules, not to the block.
  while (body.length && body[body.length - 1] === '') body.pop();
  // Rewind past blank lines consumed after the block ended.
  while (i > start && lines[i - 1].blank) i--;

  let text;
  if (header.folded) {
    const parts = [];
    for (const line of body) {
      if (line === '') {
        parts.push('\n');
      } else if (/^\s/.test(line)) {
        parts.push('\n' + line);
      } else {
        parts.push(parts.length && !parts[parts.length - 1].endsWith('\n') ? ' ' + line : line);
      }
    }
    text = parts.join('').replace(/\n(?=\S)/g, '\n');
  } else {
    text = body.join('\n');
  }

  // A block that runs to a file with no final newline keeps none either.
  const trailing = atEndOfFile && lines.finalNewline === false ? '' : '\n';
  if (header.chomp === '-') return [text, i];
  if (header.chomp === '+') return [text + trailing, i];
  return [text === '' ? '' : text + trailing, i];
}

// -- scalars ----------------------------------------------------------------

/** Parse a scalar YAML value (string, number, boolean, flow collection, null). */
export function parseScalar(value, line) {
  const raw = stripComment(String(value).trim());
  if (raw === '') return null;

  if (raw.startsWith('{') || raw.startsWith('[')) {
    const [parsed, end] = parseFlow(raw, 0, line);
    if (end !== raw.length) fail(line, `trailing text after flow collection: ${raw}`);
    return parsed;
  }

  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1)
  ) {
    return unquote(raw);
  }

  if (raw === 'true' || raw === 'True') return true;
  if (raw === 'false' || raw === 'False') return false;
  if (raw === 'null' || raw === 'Null' || raw === '~') return null;
  if (/^[-+]?\d+$/.test(raw)) return Number(raw);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) return Number(raw);
  if (/^[-+]?\d+[eE][-+]?\d+$/.test(raw)) return Number(raw);

  return raw;
}

/** Drop a trailing ` # comment`, but never one inside quotes. */
function stripComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && i > 0 && /\s/.test(value[i - 1])) return value.slice(0, i).trim();
  }
  return value;
}

/** Parse a flow collection starting at `pos`; returns [value, endIndex]. */
function parseFlow(text, pos, line) {
  const open = text[pos];
  if (open !== '{' && open !== '[') fail(line, 'expected a flow collection');
  const close = open === '{' ? '}' : ']';
  const isMap = open === '{';
  const out = isMap ? {} : [];
  let i = pos + 1;

  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] === close) return [out, i + 1];
    if (i >= text.length) break;

    if (isMap) {
      const [key, afterKey] = readFlowToken(text, i, ':', close, line);
      if (text[afterKey] !== ':') fail(line, 'flow mapping entry without a value');
      let j = afterKey + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const [value, afterValue] = readFlowValue(text, j, close, line);
      out[String(key)] = value;
      i = afterValue;
    } else {
      const [value, after] = readFlowValue(text, i, close, line);
      out.push(value);
      i = after;
    }
  }

  fail(line, 'unterminated flow collection');
}

function readFlowValue(text, pos, close, line) {
  if (text[pos] === '{' || text[pos] === '[') return parseFlow(text, pos, line);
  const [token, after] = readFlowToken(text, pos, ',', close, line);
  return [token, after];
}

/** Read one bare or quoted token up to `stop`, a comma, or the closer. */
function readFlowToken(text, pos, stop, close, line) {
  let i = pos;
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\' && quote === '"') j += 2;
      else if (text[j] === quote) break;
      else j++;
    }
    if (j >= text.length) fail(line, 'unterminated quoted string in flow collection');
    const value = unquote(text.slice(i, j + 1));
    j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    return [value, j];
  }
  while (i < text.length && text[i] !== stop && text[i] !== close && text[i] !== ',') i++;
  const bare = text.slice(pos, i).trim();
  return [parseScalar(bare, line), i];
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a JS value to a YAML string. The output is round-trippable
 * through `parseYaml`.
 */
export function stringifyYaml(data) {
  const lines = [];
  emit(data, 0, lines);
  return lines.join('\n') + '\n';
}

function emit(value, indent, lines) {
  const pad = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (isContainer(item) && !isEmptyContainer(item)) {
        const nested = [];
        emit(item, indent + 1, nested);
        lines.push(`${pad}- ${nested[0].trimStart()}`);
        for (const line of nested.slice(1)) lines.push(line);
      } else {
        lines.push(`${pad}- ${scalarText(item)}`);
      }
    }
    return;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    lines.push(`${pad}{}`);
    return;
  }
  for (const key of keys) {
    const val = value[key];
    const name = keyText(key);
    if (typeof val === 'string' && val.includes('\n')) {
      // `|` keeps the single trailing newline, `|-` strips it.
      const clip = val.endsWith('\n') && !val.endsWith('\n\n');
      lines.push(`${pad}${name}: ${clip ? '|' : '|-'}`);
      for (const line of val.replace(/\n$/, '').split('\n')) {
        lines.push(line === '' ? '' : `${pad}  ${line}`);
      }
    } else if (isContainer(val) && !isEmptyContainer(val)) {
      lines.push(`${pad}${name}:`);
      emit(val, indent + 1, lines);
    } else if (isContainer(val)) {
      lines.push(`${pad}${name}: ${Array.isArray(val) ? '[]' : '{}'}`);
    } else {
      lines.push(`${pad}${name}: ${scalarText(val)}`);
    }
  }
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

function isEmptyContainer(value) {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

function keyText(key) {
  const s = String(key);
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s) ? s : quote(s);
}

function scalarText(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  if (s === '') return '""';
  if (
    /^[\s#&*!|>'"%@`[\]{},-]/.test(s) ||
    /[:#]\s/.test(s) ||
    /\s$/.test(s) ||
    s.endsWith(':') ||
    ['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'True', 'False', 'Null', 'None', '~'].includes(s) ||
    /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ||
    // YAML 1.1 readers turn bare dates and sexagesimals into non-strings.
    /^\d[\d.]*[-:]/.test(s)
  ) {
    return quote(s);
  }
  return s;
}

function quote(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
