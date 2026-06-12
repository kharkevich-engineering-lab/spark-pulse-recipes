/**
 * Thin ds-porter push wrapper for publishing flat recipe YAML files.
 *
 * Usage:
 *   # Push a single recipe
 *   node packages/publish/index.mjs --recipe minimax-m2-awq.yaml
 *
 *   # Push all recipes + index
 *   node packages/publish/index.mjs --all
 *
 * Requires `ds` CLI installed and configured (e.g. via setup-ds-action).
 *
 * Exits 0 on success, 1 on error.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const DEFAULT_REGISTRY = 'ghcr.io';
const DEFAULT_NAMESPACE = 'sparkrecipes';
const RECIPES_DIR = 'recipes';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgsList() {
  try {
    return parseArgs({
      options: {
        recipe: { type: 'string' },
        'recipes-dir': { type: 'string', default: RECIPES_DIR },
        registry: { type: 'string', default: DEFAULT_REGISTRY },
        namespace: { type: 'string', default: DEFAULT_NAMESPACE },
        'skip-index': { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
      },
      strict: false,
    });
  } catch {
    return {
      values: {
        'recipes-dir': RECIPES_DIR,
        registry: DEFAULT_REGISTRY,
        namespace: DEFAULT_NAMESPACE,
        'skip-index': false,
        all: false,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Push helpers
// ---------------------------------------------------------------------------

function pushRecipe(recipeFile, recipesDir, registry, namespace) {
  const filePath = join(recipesDir, recipeFile);

  // Verify file exists
  try {
    readFileSync(filePath, 'utf-8');
  } catch {
    console.error(`error: ${filePath} not found`);
    return false;
  }

  const name = basename(recipeFile, '.yaml');
  const ref = `${registry}/${namespace}/${name}:latest`;

  console.log(`pushing: ${ref}`);

  const result = spawnSync(
    'ds',
    ['porter', 'push', filePath, ref],
    {
      cwd: resolve('.'),
      stdio: 'inherit',
      encoding: 'utf-8',
    }
  );

  if (result.status !== 0) {
    console.error(`error: failed to push ${name}`);
    return false;
  }

  return true;
}

function pushIndex(registry, namespace) {
  const indexPath = resolve('index.yaml');
  const ref = `${registry}/${namespace}/spark-recipes-index:latest`;

  console.log(`pushing index: ${ref}`);

  const result = spawnSync(
    'ds',
    ['porter', 'push', indexPath, ref],
    {
      cwd: resolve('.'),
      stdio: 'inherit',
      encoding: 'utf-8',
    }
  );

  if (result.status !== 0) {
    console.error(`error: failed to push index`);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgsList();
  const recipesDir = resolve(args.values['recipes-dir']);
  const registry = args.values.registry ?? DEFAULT_REGISTRY;
  const namespace = args.values.namespace ?? DEFAULT_NAMESPACE;

  let success = true;

  if (args.values.all) {
    // Push all recipe files
    const files = readdirSync(recipesDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
      .map((e) => e.name);

    if (files.length === 0) {
      console.error(`error: no .yaml files found in ${recipesDir}/`);
      process.exit(1);
    }

    for (const file of files) {
      if (!pushRecipe(file, recipesDir, registry, namespace)) {
        success = false;
      }
    }

    // Push index
    if (!args.values['skip-index']) {
      if (!pushIndex(registry, namespace)) {
        success = false;
      }
    }
  } else if (args.values.recipe) {
    // Push a single recipe file
    const recipe = args.values.recipe;
    if (!pushRecipe(recipe, recipesDir, registry, namespace)) {
      success = false;
    }

    // Push index alongside
    if (!args.values['skip-index']) {
      if (!pushIndex(registry, namespace)) {
        success = false;
      }
    }
  } else {
    console.error('error: specify --recipe <file.yaml> or --all');
    process.exit(1);
  }

  if (success) {
    console.log('done: all artifacts published');
  } else {
    console.error('failed: one or more pushes failed');
    process.exit(1);
  }
}

main();
