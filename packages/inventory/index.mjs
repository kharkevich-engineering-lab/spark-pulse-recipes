/**
 * Generate a global index.yaml listing all recipes with their metadata
 * and artifact references for ds porter push.
 *
 * Usage:
 *   node packages/inventory/index.mjs --recipes-dir ./recipes --out-dir .
 *
 * Generated files:
 *   index.yaml — global recipe inventory (maps recipe metadata → OCI refs)
 *
 * No external dependencies — uses shared lib/yaml.mjs.
 *
 * Exits 0 on success, 1 on error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { parseYaml, stringifyYaml } from '../lib/yaml.mjs';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY = 'ghcr.io';
const DEFAULT_NAMESPACE = 'sparkrecipes';
const RECIPES_DIR = 'recipes';
const RECIPES_GLOB = '*.yaml';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgsList() {
  try {
    return parseArgs({
      options: {
        'recipes-dir': { type: 'string', default: RECIPES_DIR },
        'out-dir': { type: 'string', default: '.' },
        registry: { type: 'string', default: DEFAULT_REGISTRY },
        namespace: { type: 'string', default: DEFAULT_NAMESPACE },
      },
      strict: false,
    });
  } catch {
    return {
      values: {
        'recipes-dir': RECIPES_DIR,
        'out-dir': '.',
        registry: DEFAULT_REGISTRY,
        namespace: DEFAULT_NAMESPACE,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgsList();
  const recipesDir = resolve(args.values['recipes-dir']);
  const outDir = resolve(args.values['out-dir']);
  const registry = args.values.registry ?? DEFAULT_REGISTRY;
  const namespace = args.values.namespace ?? DEFAULT_NAMESPACE;

  // Discover recipe files (*.yaml under recipes/)
  const recipeFiles = globSync(RECIPES_GLOB, {
    cwd: recipesDir,
    withFileTypes: true,
  });

  if (recipeFiles.length === 0) {
    console.error(`error: no recipe files found in ${recipesDir}/`);
    process.exit(1);
  }

  const recipes = [];

  for (const file of recipeFiles) {
    const recipePath = join(recipesDir, file.name);
    let raw;
    try {
      raw = readFileSync(recipePath, 'utf-8');
    } catch {
      console.error(`error: failed to read ${recipePath}`);
      process.exit(1);
    }

    const data = parseYaml(raw);

    if (!data || !data.name || !data.container || !data.command) {
      console.error(
        `error: ${file.name} is missing required fields (name, container, command)`
      );
      process.exit(1);
    }

    // Derive artifact name from file name (without .yaml extension)
    const artifactName = basename(file.name, '.yaml');

    recipes.push({
      name: data.name,
      artifactName,
      container: data.container,
      model: data.model ?? '',
      description: data.description ?? '',
      cluster_only: data.cluster_only ?? false,
      solo_only: data.solo_only ?? false,
      tags: [],
      artifactRef: `${registry}/${namespace}/${artifactName}`,
      path: file.name,
    });
  }

  // Sort recipes alphabetically for stable output
  recipes.sort((a, b) => a.name.localeCompare(b.name));

  // Generate index.yaml
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
