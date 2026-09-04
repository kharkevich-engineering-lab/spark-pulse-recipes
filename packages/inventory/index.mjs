/**
 * Generate index.yaml: one entry per recipe, with the metadata the Spark Pulse
 * control plane's recipe and OCI-collection views read, plus the OCI reference
 * each recipe is published under.
 *
 * The index carries v2 fields. `recipe_version` says which format the file is
 * in, `engines` lists the engines the recipe declares (preferred first), and
 * the topology constraints are flattened out of `constraints` so the same
 * `solo_only` / `cluster_only` keys keep working for v1 and v2 alike.
 *
 * Recipes are discovered recursively, so the 3x/4x/8x cluster subdirectories
 * are included and their artifact names keep the directory (three different
 * recipes share the basename qwen3.5-397b-int4-autoround.yaml).
 *
 * Usage:
 *   node packages/inventory/index.mjs --recipes-dir ./recipes --out-dir .
 *
 * Exits 0 on success, 1 on error.
 */

import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { stringifyYaml } from '../lib/yaml.mjs';
import { findRecipes, readRecipe, recipePath, summarise } from '../lib/recipes.mjs';

const DEFAULT_REGISTRY = 'ghcr.io';
const DEFAULT_NAMESPACE = 'sparkrecipes';
const RECIPES_DIR = 'recipes';

function parseArgsList() {
  return parseArgs({
    options: {
      'recipes-dir': { type: 'string', default: RECIPES_DIR },
      'out-dir': { type: 'string', default: '.' },
      registry: { type: 'string', default: DEFAULT_REGISTRY },
      namespace: { type: 'string', default: DEFAULT_NAMESPACE },
    },
    strict: false,
  });
}

function main() {
  const { values } = parseArgsList();
  const recipesDir = resolve(values['recipes-dir'] ?? RECIPES_DIR);
  const outDir = resolve(values['out-dir'] ?? '.');
  const registry = values.registry ?? DEFAULT_REGISTRY;
  const namespace = values.namespace ?? DEFAULT_NAMESPACE;

  let files;
  try {
    files = findRecipes(recipesDir);
  } catch {
    console.error(`error: cannot read ${recipesDir}/`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`error: no recipe files found in ${recipesDir}/`);
    process.exit(1);
  }

  const recipes = [];
  let failed = 0;

  for (const file of files) {
    const rel = recipePath(recipesDir, file);
    let summary;
    try {
      summary = summarise(readRecipe(file), rel);
    } catch (err) {
      console.error(`error: ${rel}: ${err.message}`);
      failed++;
      continue;
    }
    recipes.push({
      name: summary.name,
      artifactName: summary.artifactName,
      container: summary.container,
      model: summary.model,
      description: summary.description,
      recipe_version: summary.recipe_version,
      engines: summary.engines,
      solo_only: summary.solo_only,
      cluster_only: summary.cluster_only,
      min_nodes: summary.min_nodes,
      tags: [],
      artifactRef: `${registry}/${namespace}/${summary.artifactName}`,
      path: summary.path,
    });
  }

  if (failed) {
    console.error(`\n${failed} recipe(s) could not be indexed`);
    process.exit(1);
  }

  // Stable output: sort by path, which is unique, rather than by name, which
  // is not (upstream ships two recipes called Qwen36-35B-A3B).
  recipes.sort((a, b) => a.path.localeCompare(b.path));

  const index = {
    apiVersion: 'spark.vllm.io/v1',
    kind: 'RecipeInventory',
    generated: new Date().toISOString().split('T')[0],
    recipes,
  };

  const indexPath = join(outDir, 'index.yaml');
  writeFileSync(indexPath, stringifyYaml(index), 'utf-8');

  console.log(`generated: ${indexPath}`);
  console.log(`done: ${recipes.length} recipe(s) indexed`);
}

main();
