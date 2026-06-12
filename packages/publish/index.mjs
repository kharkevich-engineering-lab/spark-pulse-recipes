/**
 * ds-porter push wrapper for publishing flat recipe YAML files.
 *
 * Usage:
 *   # Push a single recipe
 *   node packages/publish/index.mjs --recipe minimax-m2-awq.yaml
 *
 *   # Push all recipes + index
 *   node packages/publish/index.mjs --all
 *
 *   # Dry-run: generate manifest and print command (no push)
 *   node packages/publish/index.mjs --all --dry-run
 *
 *   # Push using a manifest file
 *   node packages/publish/index.mjs --all --manifest
 *
 * Requires `ds` CLI installed and configured (e.g. via setup-ds-action).
 *
 * Exits 0 on success, 1 on error.
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const DEFAULT_REGISTRY = 'ghcr.io';
const DEFAULT_NAMESPACE = 'sparkrecipes';
const DEFAULT_VERSION = '1.0.0';
const RECIPES_DIR = 'recipes';

// ---------------------------------------------------------------------------
// Push helpers
// ---------------------------------------------------------------------------

function generateManifest(recipesDir, version) {
  const files = readdirSync(recipesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
    .map((e) => e.name)
    .sort();

  const manifests = files.map((f) => ({
    path: join('recipes', f),
    mediaType: 'application/vnd.delivery-station.recipe.v1+yaml',
  }));

  const lines = [
    'artifact-type: application/vnd.delivery-station.recipe.index.v1+json',
    'annotations:',
    `  name: spark-recipes`,
    `  version: ${version}`,
    `  description: Spark Pulse recipe collection`,
    `  url: https://github.com/kharkevich-engineering-lab/spark-pulse-recipes`,
    '  vendor: Kharkevich Engineering Lab',
    '  license: MIT',
    'manifests:',
  ];

  for (const m of manifests) {
    lines.push(`  - path: ${m.path}`);
    lines.push(`    mediaType: ${m.mediaType}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Push helpers
// ---------------------------------------------------------------------------

function pushRecipe(recipeFile, recipesDir, registry, namespace) {
  const filePath = join(recipesDir, recipeFile);

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

function pushWithManifest(manifestPath, registry, namespace, version) {
  const ref = `${registry}/${namespace}/spark-recipes:${version}`;

  console.log(`pushing manifest: ${ref}`);

  const result = spawnSync(
    'ds',
    ['porter', 'push', ref, '--manifest', manifestPath],
    {
      cwd: resolve('.'),
      stdio: 'inherit',
      encoding: 'utf-8',
    }
  );

  if (result.status !== 0) {
    console.error(`error: failed to push manifest`);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs({
    options: {
      recipe: { type: 'string' },
      'recipes-dir': { type: 'string', default: RECIPES_DIR },
      registry: { type: 'string', default: DEFAULT_REGISTRY },
      namespace: { type: 'string', default: DEFAULT_NAMESPACE },
      'skip-index': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      manifest: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      version: { type: 'string' },
    },
    strict: false,
  });

  const recipesDir = resolve(args.values['recipes-dir']);
  const registry = args.values.registry ?? DEFAULT_REGISTRY;
  const namespace = args.values.namespace ?? DEFAULT_NAMESPACE;
  const useManifest = args.values.manifest;
  const dryRun = args.values['dry-run'];

  // Resolve version: explicit arg > default
  const version = args.values.version ?? DEFAULT_VERSION;

  // -----------------------------------------------------------------------
  // Dry-run mode: generate manifest and print command
  // -----------------------------------------------------------------------
  if (dryRun) {
    const manifestYaml = generateManifest(recipesDir, version);
    const manifestPath = join(recipesDir, 'ds.manifest.yaml');
    console.log(`manifest:\n${manifestYaml}`);
    console.log(
      `# dry-run: would execute:\n` +
      `#   ds porter push ${registry}/${namespace}/spark-recipes:${version} --manifest=${manifestPath}`
    );
    return;
  }

  // -----------------------------------------------------------------------
  // Manifest-based push
  // -----------------------------------------------------------------------
  if (useManifest) {
    const manifestYaml = generateManifest(recipesDir, version);
    const manifestPath = join(recipesDir, 'ds.manifest.yaml');
    writeFileSync(manifestPath, manifestYaml, 'utf-8');
    console.log(`wrote manifest: ${manifestPath}`);

    const success = pushWithManifest(manifestPath, registry, namespace, version);
    if (!success) process.exit(1);
    console.log('done: manifest published');
    return;
  }

  // -----------------------------------------------------------------------
  // Traditional per-file push
  // -----------------------------------------------------------------------
  let success = true;

  if (args.values.all) {
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

    if (!args.values['skip-index']) {
      if (!pushIndex(registry, namespace)) {
        success = false;
      }
    }
  } else if (args.values.recipe) {
    const recipe = args.values.recipe;
    if (!pushRecipe(recipe, recipesDir, registry, namespace)) {
      success = false;
    }

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
