/**
 * ds-porter push wrapper: publishes every recipe as one OCI artifact under a
 * single collection index, with per-recipe annotations.
 *
 * The annotations matter: spark-pulse's OCI browser reads recipe metadata
 * straight out of the manifest, without pulling or parsing any YAML, so
 * whatever is not annotated here shows as unknown in its UI. Alongside the
 * name/model/container/solo_only/cluster_only it already carried, each entry
 * now also states `recipe_version` and the `engines` the recipe declares.
 *
 * Recipes are collected recursively, so the 3x/4x/8x cluster subdirectories
 * are published too.
 *
 * Usage:
 *   node packages/publish/index.mjs                  # push everything
 *   node packages/publish/index.mjs --version 1.0.0
 *   node packages/publish/index.mjs --dry-run        # print the manifest only
 *
 * Requires the `ds` CLI, except in --dry-run.
 *
 * Exits 0 on success, 1 on error.
 */

import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { findRecipes, readRecipe, recipePath, summarise } from '../lib/recipes.mjs';

const DEFAULT_REGISTRY = 'ghcr.io';
const DEFAULT_NAMESPACE = 'sparkrecipes';
const DEFAULT_VERSION = '1.0.0';
const RECIPES_DIR = 'recipes';
const RECIPE_MEDIA_TYPE = 'application/vnd.delivery-station.recipe.v1+yaml';
const INDEX_ARTIFACT_TYPE = 'application/vnd.delivery-station.recipe.index.v1+json';

/**
 * Quote a value for the manifest. Recipe names carry parentheses, equals
 * signs and dots — and could carry a colon — so nothing goes in bare.
 */
function q(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function collectRecipes(recipesDir) {
  const files = findRecipes(recipesDir);
  if (files.length === 0) {
    console.error(`error: no recipe files found in ${recipesDir}/`);
    process.exit(1);
  }
  return files.map((file) => {
    const rel = recipePath(recipesDir, file);
    try {
      return { path: rel, summary: summarise(readRecipe(file), rel) };
    } catch (err) {
      console.error(`error: ${rel}: ${err.message}`);
      process.exit(1);
    }
  });
}

function generateManifest(recipesDir, version) {
  const entries = collectRecipes(recipesDir).sort((a, b) => a.path.localeCompare(b.path));

  const lines = [
    `artifact-type: ${INDEX_ARTIFACT_TYPE}`,
    'annotations:',
    '  name: spark-recipes',
    `  version: ${version}`,
    '  description: Spark Pulse recipe collection',
    '  url: https://github.com/kharkevich-engineering-lab/spark-pulse-recipes',
    '  vendor: Kharkevich Engineering Lab',
    '  license: MIT',
    'manifests:',
  ];

  for (const { path, summary } of entries) {
    lines.push(`  - path: ${q(path)}`);
    lines.push(`    mediaType: ${RECIPE_MEDIA_TYPE}`);
    lines.push('    annotations:');
    lines.push(`      name: ${q(summary.name)}`);
    lines.push(`      model: ${q(summary.model)}`);
    lines.push(`      container: ${q(summary.container)}`);
    lines.push(`      recipe_version: ${q(summary.recipe_version)}`);
    lines.push(`      engines: ${q(summary.engines.join(','))}`);
    lines.push(`      solo_only: ${q(summary.solo_only)}`);
    lines.push(`      cluster_only: ${q(summary.cluster_only)}`);
    if (summary.min_nodes !== null && summary.min_nodes !== undefined) {
      lines.push(`      min_nodes: ${q(summary.min_nodes)}`);
    }
  }

  return lines.join('\n') + '\n';
}

function pushWithManifest(manifestPath, registry, namespace, repository, version) {
  const ref = `${registry}/${namespace}/${repository}:${version}`;
  console.log(`pushing: ${ref}`);

  const result = spawnSync('ds', ['porter', 'push', ref, '--manifest', manifestPath], {
    cwd: resolve('.'),
    stdio: 'inherit',
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    console.error('error: failed to push manifest');
    return false;
  }
  return true;
}

function main() {
  const { values } = parseArgs({
    options: {
      'recipes-dir': { type: 'string', default: RECIPES_DIR },
      registry: { type: 'string', default: DEFAULT_REGISTRY },
      namespace: { type: 'string', default: DEFAULT_NAMESPACE },
      repository: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      version: { type: 'string' },
    },
    strict: false,
  });

  const recipesDir = resolve(values['recipes-dir'] ?? RECIPES_DIR);
  const registry = values.registry ?? DEFAULT_REGISTRY;
  const namespace = values.namespace ?? DEFAULT_NAMESPACE;
  const repository = values.repository ?? DEFAULT_NAMESPACE;
  const version = values.version ?? DEFAULT_VERSION;
  const manifestPath = join(recipesDir, 'ds.manifest.yaml');
  const manifestYaml = generateManifest(recipesDir, version);

  if (values['dry-run']) {
    console.log(`manifest:\n${manifestYaml}`);
    console.log(
      '# dry-run: would execute:\n' +
        `#   ds porter push ${registry}/${namespace}/${repository}:${version} --manifest=${manifestPath}`
    );
    return;
  }

  writeFileSync(manifestPath, manifestYaml, 'utf-8');
  console.log(`wrote manifest: ${manifestPath}`);

  if (!pushWithManifest(manifestPath, registry, namespace, repository, version)) process.exit(1);
  console.log('done: manifest published');
}

main();
