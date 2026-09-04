# QWEN.md

Guidance for coding agents working in this repository. See `README.md` for the
user-facing description; this file records the things that are easy to get
wrong.

## What this repo is

A data repository plus a small zero-dependency Node toolchain. It holds LLM
serving recipes for [Spark Pulse](https://github.com/kharkevich-engineering-lab/spark-pulse)
on DGX Spark and publishes them to `ghcr.io` as OCI artifacts.

There is **no Python here**. Earlier documentation described a
`spark_recipe_pkg` packaging tool; it never existed in this repository. The
real tooling is `packages/`, and it is Node with no npm dependencies at all —
do not add any.

```
recipes/                 37 recipe YAML files, incl. 3x/4x/8x-spark-cluster/
schemas/                 JSON Schemas, copied from spark-pulse
packages/lib/yaml.mjs    YAML subset parser + serializer
packages/lib/recipes.mjs recipe discovery + summarising, shared
packages/validate/       schema validation
packages/inventory/      writes index.yaml (generated, gitignored)
packages/publish/        ds-porter manifest + push
.github/workflows/       validate.yml, publish.yml
```

## The recipe format is owned elsewhere

`schemas/recipe.schema.json`, `recipe-v1.schema.json` and `recipe-v2.schema.json`
are **copies** of `spark_pulse/schemas/*.json`. Never edit them here. Change
them in spark-pulse, where `spark_pulse/tools/recipe_schema.py` is the matching
in-process parser, then copy the files back.

Two versions coexist and both stay valid:

- **v1** — `name` + `container` + a full vLLM `command` template. This is the
  upstream `eugr/spark-vllm-docker` shape. A v1 command is written in vLLM's
  flags, so a v1 recipe can only ever run on vLLM.
- **v2** — `recipe_version: "2"`, `model`, `constraints`, engine-neutral
  `params`, and per-engine overrides under `engines`. Every recipe in this
  repository is v2.

`recipe.schema.json` is a `oneOf` over the two, dispatching on
`recipe_version` (absent or `"1"` is v1). Because it is a `oneOf`, a document
must match exactly one branch — a v2 recipe that accidentally kept a
`container:` and a `command:` would match both and be rejected.

### v2 field rules that matter

- `params` holds only values that mean the same thing on any engine: `port`,
  `host`, `tensor_parallel`, `pipeline_parallel`, `gpu_memory_utilization`,
  `max_model_len`, `max_num_batched_tokens`, `max_num_seqs`. Each engine maps
  them onto its own flags.
- `gpu_memory_utilization` in `params` is a **fraction between 0 and 1**. The
  schema enforces it. Upstream recipes using the `gpu-mem-util-gb` mod pass a
  GiB figure (108); that belongs in the vLLM args as
  `--gpu-memory-utilization-gb`, never in `params`.
- `max_model_len` in `params` is an **integer**. `auto` belongs in the args.
- Anything engine-specific — flags, `mods`, `build_args`, `env`, the container
  as `image` — goes under `engines.<name>`.
- `args` is substituted with `str.format`, so `{param}` interpolates and `{{`
  / `}}` are literal braces. Every placeholder left in `args` must name a key
  that exists in `params`, or the render fails at deploy time.
- `constraints.min_nodes` records a hard node floor; the 3x/4x/8x directories
  set 3, 4 and 8.
- A recipe runs only on the engines it lists under `engines`. Adding an
  `engines.sglang` block is a claim; see the README for the bar it has to
  clear, and put what is unverified in a comment.

## Conventions

- Recipes keep upstream's directory layout, so three files share the basename
  `qwen3.5-397b-int4-autoround.yaml`. Anything that names a recipe must derive
  that name from the path below `recipes/`, not the basename —
  `packages/lib/recipes.mjs` does this.
- Two upstream recipe **names** also repeat. That is upstream's, kept verbatim.
- `--distributed-executor-backend ray` is never carried into a recipe: Spark
  Pulse does not use Ray and its vLLM engine strips the flag.
- `index.yaml` and `recipes/ds.manifest.yaml` are generated and gitignored.
- Conventional commits with lowercase subjects; semantic-release derives the
  version from them on `main`.

## Before you commit

```bash
node packages/validate/index.mjs        # all 37 must pass
node packages/inventory/index.mjs       # must index all 37
node packages/publish/index.mjs --dry-run
```

Then cross-check against the real parser, which is the authority — this repo's
validator agreeing is not sufficient:

```bash
cd ../spark-pulse && .venv/bin/python -c \
  "from spark_pulse.tools.recipe_schema import validate_recipe_dir; \
   print([r for r in validate_recipe_dir('../spark-pulse-recipes/recipes') if not r['ok']])"
```

If you touch `packages/lib/yaml.mjs`, re-check it against PyYAML rather than
trusting the validator: the parser is a subset implementation and its round
trip feeds the published inventory, so a quiet wrong answer is the failure
mode to watch for.
