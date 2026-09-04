/**
 * Validate Spark Pulse recipes against the canonical JSON Schema.
 *
 * The schemas in `schemas/` are copied from spark-pulse, which owns the
 * format. `recipe.schema.json` is a `oneOf` over two versions:
 *
 *   v1 — the upstream spark-vllm-docker shape: `name` + `container` +
 *        a vLLM `command` template. Still valid, never removed.
 *   v2 — `recipe_version: "2"`, engine-neutral `params`, per-engine
 *        overrides under `engines`.
 *
 * Dispatch is on `recipe_version`, so exactly one branch of the `oneOf` can
 * match any given document.
 *
 * No external dependencies — the Draft-07 subset below covers what these
 * schemas use: `$ref` (resolved through an `$id` registry, since the refs are
 * URLs we must not fetch), `oneOf`, `type`, `enum`, `required`,
 * `properties`, `additionalProperties` (boolean and schema),
 * `propertyNames`, `items`, `dependencies`, `minLength`, `minimum`,
 * `maximum` and `exclusiveMinimum`.
 *
 * Usage:
 *   node packages/validate/index.mjs                     # whole recipes/ tree
 *   node packages/validate/index.mjs --dir recipes/x.yaml
 *   node packages/validate/index.mjs --dir recipes/4x-spark-cluster
 *
 * Exits 0 when every recipe is valid, 1 otherwise.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseYaml } from '../lib/yaml.mjs';
import { findRecipes } from '../lib/recipes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SCHEMA_DIR = resolve(ROOT, 'schemas');
const DEFAULT_RECIPES_DIR = resolve(ROOT, 'recipes');

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

const SCHEMA_FILES = [
  'recipe.schema.json',
  'recipe-v1.schema.json',
  'recipe-v2.schema.json',
];

/** Load every published schema, keyed by `$id` so `$ref` resolves offline. */
function loadSchemas() {
  const byId = new Map();
  let entry = null;
  for (const file of SCHEMA_FILES) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf-8'));
    if (schema.$id) byId.set(schema.$id, schema);
    if (file === 'recipe.schema.json') entry = schema;
  }
  if (!entry) throw new Error('schemas/recipe.schema.json is missing');
  return { entry, byId };
}

// ---------------------------------------------------------------------------
// Draft-07 subset validator
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value; // string | boolean | object
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((t) => {
    if (t === 'number') return actual === 'number' || actual === 'integer';
    if (t === 'object') return actual === 'object';
    return actual === t;
  });
}

function join_(path, key) {
  return path ? `${path}.${key}` : String(key);
}

/**
 * Validate `data` against `schema`, appending `{path, message}` problems.
 * Returns the problem list (empty when valid).
 */
function validate(data, schema, registry, path = '', errors = []) {
  if (schema === true || schema === undefined) return errors;
  if (schema === false) {
    errors.push({ path, message: 'value is not allowed here' });
    return errors;
  }

  if (schema.$ref) {
    const target = registry.get(schema.$ref);
    if (!target) throw new Error(`unresolvable $ref: ${schema.$ref}`);
    return validate(data, target, registry, path, errors);
  }

  if (schema.type && !matchesType(data, schema.type)) {
    const want = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
    errors.push({ path, message: `must be of type ${want}, got ${typeOf(data)}` });
    return errors; // further keywords would only add noise
  }

  if (schema.enum && !schema.enum.some((v) => v === data)) {
    errors.push({
      path,
      message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
    });
  }

  if (schema.oneOf) {
    const branches = schema.oneOf.map((sub) => validate(data, sub, registry, path, []));
    const passed = branches.filter((e) => e.length === 0).length;
    if (passed !== 1) {
      const detail = branches
        .map((e, i) => `  branch ${i + 1}: ${e.map((x) => `${x.path || '.'}: ${x.message}`).join('; ') || 'matched'}`)
        .join('\n');
      errors.push({
        path,
        message:
          passed === 0
            ? `does not match any known recipe version\n${detail}`
            : `matches ${passed} recipe versions at once, which is ambiguous\n${detail}`,
      });
    }
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} character(s) long` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      errors.push({ path, message: `must match ${schema.pattern}` });
    }
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) {
      errors.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
    }
    if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) {
      errors.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
    }
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((item, i) => validate(item, schema.items, registry, `${path}[${i}]`, errors));
  }

  if (typeOf(data) === 'object') {
    for (const key of schema.required ?? []) {
      if (data[key] === undefined || data[key] === null) {
        errors.push({ path, message: `must have required property '${key}'` });
      }
    }

    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const [key, value] of Object.entries(data)) {
      if (schema.propertyNames) {
        validate(key, schema.propertyNames, registry, join_(path, key), errors);
      }
      if (known.has(key)) {
        validate(value, schema.properties[key], registry, join_(path, key), errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: join_(path, key), message: 'is not a recognised property' });
      } else if (typeOf(schema.additionalProperties) === 'object') {
        validate(value, schema.additionalProperties, registry, join_(path, key), errors);
      }
    }

    for (const [key, dep] of Object.entries(schema.dependencies ?? {})) {
      if (data[key] === undefined) continue;
      if (Array.isArray(dep)) {
        for (const needed of dep) {
          if (data[needed] === undefined) {
            errors.push({ path, message: `'${key}' requires '${needed}'` });
          }
        }
      } else {
        validate(data, dep, registry, path, errors);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function describe(data) {
  const version = data.recipe_version === undefined ? '1' : String(data.recipe_version);
  if (version === '2') {
    const engines = Object.keys(data.engines ?? {});
    return `v2, ${data.model}, engines: ${engines.length ? engines.join('+') : 'generic'}`;
  }
  return `v1, ${data.container}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const { values } = parseArgs({
    options: { dir: { type: 'string' }, quiet: { type: 'boolean', default: false } },
    strict: false,
  });

  const target = values.dir ? resolve(values.dir) : DEFAULT_RECIPES_DIR;
  let files;
  try {
    files = statSync(target).isDirectory() ? findRecipes(target) : [target];
  } catch {
    console.error(`error: ${target} not found`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`error: no recipes found under ${target}`);
    process.exit(1);
  }

  const { entry, byId } = loadSchemas();
  let failed = 0;

  for (const file of files) {
    const label = relative(ROOT, file);
    let data;
    try {
      data = parseYaml(readFileSync(file, 'utf-8'));
    } catch (err) {
      console.error(`FAIL ${label}\n  - .: ${err.message}`);
      failed++;
      continue;
    }

    if (typeOf(data) !== 'object') {
      console.error(`FAIL ${label}\n  - .: recipe must be a YAML mapping`);
      failed++;
      continue;
    }

    const errors = validate(data, entry, byId);
    if (errors.length) {
      console.error(`FAIL ${label}`);
      for (const e of errors) console.error(`  - ${e.path || '.'}: ${e.message}`);
      failed++;
      continue;
    }

    if (!values.quiet) console.log(`ok   ${label} — ${data.name} (${describe(data)})`);
  }

  const total = files.length;
  if (failed) {
    console.error(`\n${failed} of ${total} recipe(s) failed validation`);
    process.exit(1);
  }
  console.log(`\n${total} recipe(s) valid`);
}

main();
