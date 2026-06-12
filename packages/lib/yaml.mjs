/**
 * Minimal YAML parser/serializer — no external dependencies.
 * Supports the subset used by Spark recipes and index.yaml.
 */

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a JS object.
 */
export function parseYaml(text) {
  const lines = text.split('\n');
  const result = {};
  let multiLineBuffer = null;
  let multiLineKey = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (multiLineBuffer !== null) {
        result[multiLineKey] = multiLineBuffer.trim();
        multiLineBuffer = null;
        multiLineKey = null;
      }
      continue;
    }

    // If we're accumulating a multi-line block
    if (multiLineBuffer !== null) {
      const indent = line.search(/\S/);
      const keyIndent = line.indexOf(multiLineKey);
      if (indent > keyIndent || line.match(/^\s+/)) {
        multiLineBuffer += '\n' + line.replace(/^\s+/, '');
        continue;
      } else {
        result[multiLineKey] = multiLineBuffer.trim();
        multiLineBuffer = null;
        multiLineKey = null;
      }
    }

    // Check if this is a list item
    const arrayMatch = trimmed.match(/^-\s+(.+)$/);
    if (arrayMatch) {
      // This is part of an array started earlier
      continue;
    }

    // Check if this is a key-value pair
    const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      // Start of a multi-line block (|)
      if (value === '|') {
        multiLineBuffer = '';
        multiLineKey = key;
        continue;
      }

      // Inline object or array
      if (value.startsWith('{') || value.startsWith('[')) {
        result[key] = parseScalar(value);
        continue;
      }

      // Start of an array (next line has list items)
      if (value === '' || value === '[]') {
        let nextIdx = i + 1;
        while (nextIdx < lines.length && lines[nextIdx].trim() === '') nextIdx++;
        if (nextIdx < lines.length && lines[nextIdx].match(/^\s+-\s+/)) {
          const array = [];
          let j = i + 1;
          while (j < lines.length) {
            const aLine = lines[j].trim();
            if (aLine === '') { j++; continue; }
            const arrMatch = aLine.match(/^-\s+(.+)$/);
            if (arrMatch) {
              array.push(parseScalar(arrMatch[1]));
              j++;
            } else {
              break;
            }
          }
          result[key] = array;
          i = j - 1;
          continue;
        } else {
          result[key] = null;
          continue;
        }
      }

      // Nested object (next line is indented key-value)
      if (value === '' || (i + 1 < lines.length && lines[i + 1].match(/^\s{2,}\S/))) {
        const nested = parseNestedBlock(lines, i + 1);
        result[key] = nested.obj;
        i = nested.endIndex;
        continue;
      }

      // Regular key-value
      result[key] = parseScalar(value);
      continue;
    }
  }

  // Flush any remaining multi-line
  if (multiLineBuffer !== null) {
    result[multiLineKey] = multiLineBuffer.trim();
  }

  return result;
}

/**
 * Parse a nested YAML block (indented key-value pairs).
 */
function parseNestedBlock(lines, startIndex) {
  const result = {};
  let i = startIndex;

  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return { obj: result, endIndex: i - 1 };

  const firstLine = lines[i];
  const baseIndent = firstLine.search(/\S/);

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break;

    const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      if (value.startsWith('{') || value.startsWith('[')) {
        result[key] = parseScalar(value);
      } else if (value === '') {
        let nextIdx = i + 1;
        while (nextIdx < lines.length && lines[nextIdx].trim() === '') nextIdx++;
        if (nextIdx < lines.length && lines[nextIdx].match(/^\s{2,}\S/)) {
          const nested = parseNestedBlock(lines, nextIdx);
          result[key] = nested.obj;
          i = nested.endIndex;
        } else {
          result[key] = null;
        }
      } else {
        result[key] = parseScalar(value);
      }
    }
    i++;
  }

  return { obj: result, endIndex: i - 1 };
}

/**
 * Parse a scalar YAML value (string, number, boolean, inline object/array, null).
 */
function parseScalar(value) {
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Inline object
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return {};
    const obj = {};
    const pairs = inner.split(',');
    for (const pair of pairs) {
      const [k, ...vParts] = pair.split(':');
      obj[k.trim()] = parseScalar(vParts.join(':').trim());
    }
    return obj;
  }

  // Inline array
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => parseScalar(s.trim()));
  }

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'null' || value === '~') return null;

  return value;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a JS object to a YAML string.
 */
export function stringifyYaml(data) {
  return serializeValue(data, 0, false) + '\n';
}

function isMultiline(value) {
  if (typeof value !== 'string') return false;
  return value.includes('\n') || value.length > 80;
}

function serializeScalar(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  const s = String(val);
  // Quote strings that could be misinterpreted
  if (s === '' || s === 'true' || s === 'false' || s === 'null' ||
      ['yes', 'no', 'on', 'off', 'True', 'False', 'None'].includes(s) ||
      /^[0-9]/.test(s) || s.includes(':') || s.includes('#') || s.includes("'") || s.includes('"')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function serializeValue(value, indentLevel, asListItem) {
  const indent = '  '.repeat(indentLevel);
  const listIndent = '  '.repeat(indentLevel + 1);

  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((item) => {
      const inner = serializeValue(item, indentLevel + 1, true);
      return `${listIndent}- ${inner}`;
    }).join('\n');
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';

    const lines = [];
    for (const key of keys) {
      const val = value[key];
      const kstr = String(key);

      if (val === null || val === undefined) {
        lines.push(`${indent}${kstr}: null`);
      } else if (Array.isArray(val)) {
        // Block array
        lines.push(`${kstr}:`);
        for (const item of val) {
          if (typeof item === 'object' && item !== null) {
            // Object as array item: first key on same line as -, rest indented deeper
            const keys = Object.keys(item);
            for (let i = 0; i < keys.length; i++) {
              const kk = keys[i];
              const vv = item[kk];
              if (i === 0) {
                if (Array.isArray(vv)) {
                  lines.push(`${listIndent}- ${kk}:`);
                } else {
                  lines.push(`${listIndent}- ${kk}: ${serializeScalar(vv)}`);
                }
              } else {
                if (Array.isArray(vv)) {
                  lines.push(`${listIndent}${listIndent}${kk}:`);
                } else {
                  lines.push(`${listIndent}${listIndent}${kk}: ${serializeScalar(vv)}`);
                }
              }
            }
          } else {
            lines.push(`${listIndent}- ${serializeScalar(item)}`);
          }
        }
      } else if (isMultiline(val)) {
        // Multi-line string: put | on same line as key, then indented content
        lines.push(`${indent}${kstr}: |`);
        const str = String(val);
        for (const line of str.split('\n')) {
          lines.push(`${listIndent}${line}`);
        }
      } else if (typeof val === 'object' && !Array.isArray(val)) {
        // Nested object
        const nested = serializeValue(val, indentLevel + 1, false);
        // nested is multi-line, split and prefix each line
        for (const line of nested.split('\n')) {
          lines.push(`${listIndent}${line}`);
        }
      } else {
        // Simple scalar
        let sval;
        if (typeof val === 'string') {
          sval = val;
          // Quote strings that could be misinterpreted
          if (sval === '' || ['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'True', 'False', 'None'].includes(sval) ||
              /^[0-9]/.test(sval) || sval.includes(':') || sval.includes('#') || sval.includes("'") || sval.includes('"')) {
            sval = `"${sval.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
          }
        } else {
          sval = String(val);
        }
        lines.push(`${indent}${kstr}: ${sval}`);
      }
    }
    return lines.join('\n');
  }

  // Plain string
  return String(value);
}
