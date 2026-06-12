/**
 * Validate Spark vLLM recipe YAML against the canonical JSON Schema.
 *
 * Recipe format:
 *   name: Human-readable name          (required)
 *   container: docker-image-name       (required)
 *   command: |                         (required)
 *     vllm serve model/name \
 *         --port {port} \
 *         --host {host}
 *
 *   description: ...                   (optional)
 *   model: org/model-name              (optional)
 *   cluster_only: false                (optional)
 *   solo_only: false                   (optional)
 *   build_args: [...]                  (optional)
 *   mods: [...]                        (optional)
 *   defaults: { port, host, ... }      (optional)
 *   env: { KEY: val }                 (optional)
 *
 * The JSON Schema is external and can be consumed by VS Code, IDE extensions,
 * and other tooling. See spark-recipe.schema.json for the full definition.
 *
 * No external dependencies — uses only Node.js built-in modules.
 *
 * Usage:
 *   node packages/validate/index.mjs --dir recipes/minimax-m2-awq.yaml
 *
 * Exits 0 on success, 1 on validation error.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseYaml } from '../lib/yaml.mjs';

// ---------------------------------------------------------------------------
// Load external JSON Schema
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, '..', '..', 'spark-recipe.schema.json');
const SCHEMA = JSON.parse(readFileSync(schemaPath, 'utf-8'));

// ---------------------------------------------------------------------------
// Simple JSON Schema validator (subset for our recipe format)
// ---------------------------------------------------------------------------

/**
 * Validate a parsed YAML object against the JSON Schema.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
function validateAgainstSchema(data, schema) {
  const errors = [];

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (data[field] === undefined || data[field] === null) {
        errors.push(`.: must have required property '${field}'`);
      }
    }
  }

  // Validate types for defined properties
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const value = data[key];
      if (value === undefined || value === null) continue;

      if (propSchema.type) {
        let valid = true;

        if (propSchema.type === 'string') {
          if (typeof value !== 'string') valid = false;
          if (propSchema.minLength && value.length < propSchema.minLength) {
            valid = false;
          }
        } else if (propSchema.type === 'number') {
          if (typeof value !== 'number') valid = false;
        } else if (propSchema.type === 'boolean') {
          if (typeof value !== 'boolean') valid = false;
        } else if (propSchema.type === 'array') {
          if (!Array.isArray(value)) valid = false;
        } else if (propSchema.type === 'object') {
          if (typeof value !== 'object' || Array.isArray(value)) valid = false;
        }

        if (!valid) {
          errors.push(`.: ${key} must be of type ${propSchema.type}`);
        }
      }

      // Recurse into nested objects
      if (propSchema.type === 'object' && propSchema.properties && typeof value === 'object') {
        const nestedResult = validateAgainstSchema(value, {
          type: 'object',
          properties: propSchema.properties,
          required: propSchema.required,
        });
        for (const err of nestedResult.errors) {
          errors.push(`${key}${err.replace(':.', `.${key}`)}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgsList() {
  try {
    return parseArgs({
      options: {
        dir: { type: 'string' },
      },
      strict: false,
    });
  } catch {
    return {};
  }
}

function main() {
  const args = parseArgsList();
  const recipePath = resolve(args.values.dir ?? '.');
  const isDir = statSync(recipePath).isDirectory();

  // Support both --dir ./recipes/minimax-m2-awq.yaml (flat file)
  // and --dir ./recipes/minimax-m2-awq (directory with recipe.yaml)
  const targetPath = isDir ? resolve(recipePath, 'recipe.yaml') : recipePath;

  // Read recipe
  let raw;
  try {
    raw = readFileSync(targetPath, 'utf-8');
  } catch (err) {
    console.error(`error: ${targetPath} not found`);
    process.exit(1);
  }

  // Parse YAML (inline parser, no external deps)
  let data;
  try {
    data = parseYaml(raw);
  } catch (err) {
    console.error(`error: failed to parse YAML: ${err.message}`);
    process.exit(1);
  }

  // Validate against JSON Schema
  const result = validateAgainstSchema(data, SCHEMA);

  if (!result.valid) {
    console.error('validation failed:');
    result.errors.forEach((err) => {
      console.error(`  - ${err}`);
    });
    process.exit(1);
  }

  console.log(`ok: ${data.name} (${data.container})`);
  process.exit(0);
}

main();
