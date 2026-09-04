# Spark Pulse Recipes

LLM serving recipes for [Spark Pulse](https://github.com/kharkevich-engineering-lab/spark-pulse)
on NVIDIA DGX Spark. Each recipe is a YAML file describing how to serve one
model: which checkpoint, which engine, which container image, which flags, and
how many nodes it needs. They are published to `ghcr.io` as OCI artifacts and
installed from Spark Pulse's OCI browser.

Everything in this repo is data plus a small zero-dependency Node toolchain
that validates, indexes and publishes that data. There is no Python package
here and no runtime code — Spark Pulse itself consumes these files.

## Recipe format

Recipes are written in **v2**, the engine-portable format. A v2 recipe splits
the parameters that mean the same thing on any serving engine from the flags
that belong to one:

```yaml
recipe_version: "2"
name: Qwen3.5-122B-FP8
model: Qwen/Qwen3.5-122B-A10B-FP8   # default checkpoint, overridable at deploy
description: >-
  What this recipe serves and why its numbers are what they are.

engine: vllm                        # default engine when the request names none

constraints:                        # enforced at plan time
  solo_only: false
  cluster_only: true
  min_nodes: 4

params:                             # engine-neutral, shown in the deploy form
  port: 8000
  host: 0.0.0.0
  tensor_parallel: 4
  pipeline_parallel: 1
  gpu_memory_utilization: 0.85
  max_model_len: 262144
  max_num_batched_tokens: 8192
  max_num_seqs: 32

engines:                            # a recipe runs only on the engines it lists
  vllm:
    image: vllm-node
    mods: [mods/fix-qwen3.5-chat-template]
    env: {VLLM_MARLIN_USE_ATOMIC_ADD: "1"}
    args: >-                        # engine-specific tail; may use {params}
      --load-format instanttensor --enable-prefix-caching
  sglang:
    args: --chunked-prefill-size 8192
```

Each engine maps `params` onto its own flags — `tensor_parallel` is
`--tensor-parallel-size` for vLLM and `--tp` for SGLang — then appends that
engine's `args`. A `{placeholder}` in `args` is substituted from the resolved
params, so `{{` and `}}` are literal braces (which is how the JSON blobs in
`--speculative-config` survive).

**v1 recipes remain valid.** v1 is the original
[spark-vllm-docker](https://github.com/eugr/spark-vllm-docker) shape: `name`,
`container` and a full vLLM `command` template. The validator accepts both;
new recipes should be v2, because a v1 command template is written in vLLM's
flags and therefore pins the recipe to vLLM.

### Where the schema comes from

`schemas/` holds three JSON Schema files **copied verbatim from spark-pulse**,
which owns the recipe format:

| File | Source |
|---|---|
| `schemas/recipe.schema.json` | `spark_pulse/schemas/recipe.schema.json` |
| `schemas/recipe-v1.schema.json` | `spark_pulse/schemas/recipe-v1.schema.json` |
| `schemas/recipe-v2.schema.json` | `spark_pulse/schemas/recipe-v2.schema.json` |

Do not edit them here. Change them in spark-pulse — where
`spark_pulse/tools/recipe_schema.py` is the matching in-process parser — and
copy the result back. `recipe.schema.json` is the entry point: a `oneOf` over
the two versioned schemas, dispatching on `recipe_version`.

## Recipes

37 recipes: all 36 from upstream spark-vllm-docker, converted to v2 and keeping
upstream's directory layout, plus one new NVFP4 recipe. "Engines" is what the
recipe declares, not what has been proven on hardware.

| Path | Name | Model | Engines | Topology |
|---|---|---|---|---|
| `3x-spark-cluster/qwen3.5-397b-int4-autoround.yaml` | Qwen3.5-397B-INT4-Autoround (PP=3) | Intel/Qwen3.5-397B-A17B-int4-AutoRound | vllm | cluster, min 3 |
| `4x-spark-cluster/minimax-m2.5.yaml` | MiniMax-M2.5 | MiniMaxAI/MiniMax-M2.5 | vllm | cluster, min 4 |
| `4x-spark-cluster/nemotron-3-ultra-nvfp4.yaml` | Nemotron-3-Ultra-NVFP4 | nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4 | vllm | cluster, min 4 |
| `4x-spark-cluster/qwen3.5-397b-a17B-fp8.yaml` | Qwen3.5-397B-A17B-FP8 | Qwen/Qwen3.5-397B-A17B-FP8 | vllm | cluster, min 4 |
| `4x-spark-cluster/qwen3.5-397b-int4-autoround.yaml` | Qwen3.5-397B-INT4-Autoround | Intel/Qwen3.5-397B-A17B-int4-AutoRound | vllm | cluster, min 4 |
| `8x-spark-cluster/glm-5.2-nvfp4.yaml` | GLM-5.2-NVFP4 (TP=8) | nvidia/GLM-5.2-NVFP4 | vllm | cluster, min 8 |
| `deepseek-v4-flash-0731.yaml` | DeepSeek-V4-Flash-0731 | deepseek-ai/DeepSeek-V4-Flash-0731 | vllm | cluster |
| `deepseek-v4-flash.yaml` | DeepSeek-V4-Flash | deepseek-ai/DeepSeek-V4-Flash | vllm | cluster |
| `diffusion-gemma-bf16-thinking.yaml` | Diffusion-Gemma-BF16-Thinking | google/diffusiongemma-26B-A4B-it | vllm | solo |
| `diffusion-gemma-bf16.yaml` | Diffusion-Gemma-BF16 | google/diffusiongemma-26B-A4B-it | vllm | solo |
| `diffusion-gemma-nvfp4-thinking.yaml` | Diffusion-Gemma-NVFP4-Thinking | nvidia/diffusiongemma-26B-A4B-it-NVFP4 | vllm | solo |
| `diffusion-gemma-nvfp4.yaml` | Diffusion-Gemma-NVFP4 | nvidia/diffusiongemma-26B-A4B-it-NVFP4 | vllm | solo |
| `gemma4-26b-a4b-nvfp4.yaml` | Gemma4-26B-A4B-NVFP4 | nvidia/Gemma-4-26B-A4B-NVFP4 | vllm | solo |
| `gemma4-26b-a4b.yaml` | Gemma4-26B-A4B | google/gemma-4-26B-A4B-it | vllm, **sglang** | any |
| `glm-4.7-flash-awq.yaml` | GLM-4.7-Flash-AWQ | cyankiwi/GLM-4.7-Flash-AWQ-4bit | vllm, **sglang** | any |
| `inkling-small-nvfp4.yaml` | Inkling-Small-NVFP4 | thinkingmachines/Inkling-Small-NVFP4 | vllm | cluster |
| `minimax-m2-awq.yaml` | MiniMax-M2-AWQ | QuantTrio/MiniMax-M2-AWQ | vllm, **sglang** | cluster |
| `minimax-m2.5-awq.yaml` | MiniMax-M2.5-AWQ | cyankiwi/MiniMax-M2.5-AWQ-4bit | vllm | cluster |
| `minimax-m2.7-awq.yaml` | MiniMax-M2.7-AWQ | cyankiwi/MiniMax-M2.7-AWQ-4bit | vllm | cluster |
| `nemotron-3-nano-nvfp4.yaml` | Nemotron-3-Nano-NVFP4 | nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4 | vllm | solo |
| `nemotron-3-super-nvfp4.yaml` | Nemotron-3-Super-NVFP4-CUTLASS-Optimized | nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 | vllm | any |
| `nemotron-3.5-lightning.yaml` | NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 | nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 | vllm | any |
| `openai-gpt-oss-120b.yaml` | OpenAI-GPT-OSS-120B | openai/gpt-oss-120b | vllm | solo |
| `qwen3-coder-next-fp8.yaml` | Qwen3-Coder-Next-FP8 | Qwen/Qwen3-Coder-Next-FP8 | vllm | any |
| `qwen3-coder-next-int4-autoround.yaml` | Qwen3-Coder-Next-int4-Autoround | Intel/Qwen3-Coder-Next-int4-AutoRound | vllm | solo |
| `qwen3.5-122b-fp8.yaml` | Qwen3.5-122B-FP8 | Qwen/Qwen3.5-122B-A10B-FP8 | vllm | cluster |
| `qwen3.5-122b-int4-autoround.yaml` | Qwen3.5-122B-INT4-Autoround | Intel/Qwen3.5-122B-A10B-int4-AutoRound | vllm | any |
| `qwen3.5-35b-a3b-fp8.yaml` | Qwen35-35B-A3B | Qwen/Qwen3.5-35B-A3B-FP8 | vllm | any |
| `qwen3.5-397b-int4-autoround.yaml` | Qwen3.5-397B-INT4-Autoround | Intel/Qwen3.5-397B-A17B-int4-AutoRound | vllm | cluster |
| `qwen3.6-35b-a3b-fp8-dflash.yaml` | Qwen36-35B-A3B | Qwen/Qwen3.6-35B-A3B-FP8 | vllm | any |
| `qwen3.6-35b-a3b-fp8.yaml` | Qwen36-35B-A3B | Qwen/Qwen3.6-35B-A3B-FP8 | vllm | any |
| `qwen3.6-35b-a3b-nvfp4-no-mtp.yaml` | Qwen3.6-35B-A3B-NVFP4-Marlin-No-MTP | nvidia/Qwen3.6-35B-A3B-NVFP4 | vllm | any |
| `qwen3.6-35b-a3b-nvfp4.yaml` | Qwen3.6-35B-A3B-NVFP4-Marlin | nvidia/Qwen3.6-35B-A3B-NVFP4 | vllm | any |
| `qwen3.8-27b-nvfp4-dflash2.yaml` | Qwen3.8-27B-NVFP4-DFlash2 | RadixArk/Qwen3.8-27B-NVFP4 | vllm | any |
| `qwen3.8-27b-nvfp4-unsloth.yaml` | Qwen3.8-27B-NVFP4 (Unsloth) | unsloth/Qwen3.8-27B-NVFP4 | vllm | any |
| `step-3.7-flash-fp8.yaml` | Step-3.7-Flash-FP8 | stepfun-ai/Step-3.7-Flash-FP8 | vllm | cluster |
| `step-3.7-flash-nvfp4.yaml` | Step-3.7-Flash-NVFP4 | stepfun-ai/Step-3.7-Flash-NVFP4 | vllm | cluster |

Two upstream names repeat (`Qwen3.5-397B-INT4-Autoround`, `Qwen36-35B-A3B`).
They are kept verbatim; the path is what identifies a recipe here, and the
artifact name is derived from it.

### Why almost everything is vLLM only

An `engines.sglang` block is a claim that the recipe would work on SGLang, so
one is only present where that claim is defensible. A recipe stays vLLM only
when it depends on any of:

- **vLLM mods** — patches applied inside the container. SGLang has no mod
  mechanism at all, so a recipe whose chat template, weight loader or kernel
  fix arrives as a mod cannot run anywhere else.
- **A vLLM-only image** — `vllm-node-b12x` or `vllm-node-mxfp4`.
- **B12X kernels** — `--moe-backend b12x`, `--attention-backend B12X`,
  `B12X_MLA_SPARSE`.
- **vLLM-only flags** — `--load-format instanttensor`, `--mxfp4-backend`,
  `--diffusion-config`, `--reasoning-parser-plugin`, `--speculative-config`
  and the `--mamba-*` cache controls.
- **A quantisation path that is vLLM's** — NVFP4 through vLLM's Marlin or
  CUTLASS MoE backends, INT4-AutoRound through Marlin.

Three recipes clear that bar: `gemma4-26b-a4b`, `glm-4.7-flash-awq` and
`minimax-m2-awq`. Each is a plain dense or MoE checkpoint in a format SGLang
supports, with no mods, the stock image and no vLLM-only loader. None has been
run on a Spark under SGLang; each block says in a comment what specifically is
unverified about it (usually the parser names, which SGLang spells differently
from vLLM).

### Notes on the conversion from upstream v1

- The engine-neutral values were lifted out of the `command` template into
  `params`, including ones that were literals in the template rather than
  entries in `defaults`.
- Everything else moved under `engines.vllm`: every vLLM flag, `mods`,
  `build_args`, `env`, and `container` as `image`. Non-neutral `defaults`
  (`block_size`, `num_speculative_tokens`, `served_model_name`, …) are inlined
  as literals in `args` rather than exposed as pseudo-neutral params.
- `--distributed-executor-backend ray` is dropped everywhere. Spark Pulse
  never uses Ray and its vLLM engine strips the flag; each affected recipe
  says so.
- Two recipes (`qwen3.5-397b-int4-autoround.yaml` and `step-3.7-flash-fp8.yaml`)
  set `gpu_memory_utilization: 108`. That is **GiB**, not a fraction: they use
  the `gpu-mem-util-gb` mod, which replaces the flag with
  `--gpu-memory-utilization-gb`. It cannot live in `params`, where the value
  means a 0–1 fraction on every engine, so it stays literal in the vLLM args.
- `deepseek-v4-flash-0731.yaml` sets `max_model_len: auto`, which is not a
  number, so `--max-model-len auto` also stays in the vLLM args.

## Tooling

Zero dependencies, Node 26, run from the repo root.

```bash
node packages/validate/index.mjs                        # validate every recipe
node packages/validate/index.mjs --dir recipes/x.yaml   # or one file/directory
node packages/inventory/index.mjs                       # write index.yaml
node packages/publish/index.mjs --dry-run               # print the OCI manifest
node packages/publish/index.mjs --version 1.2.0         # push via `ds porter`
```

| Package | What it does |
|---|---|
| `packages/lib/yaml.mjs` | YAML subset parser and serializer. Block mappings and sequences at any depth, all six block-scalar headers, flow collections, quoted scalars. Checked against PyYAML over every recipe in this repo, in spark-pulse and upstream. |
| `packages/lib/recipes.mjs` | Recipe discovery and summarising, shared by the other three so they always see the same files and read the same fields. |
| `packages/validate/index.mjs` | Validates against `schemas/recipe.schema.json` with a Draft-07 subset validator (`$ref` via an `$id` registry, `oneOf`, `enum`, `propertyNames`, `dependencies`, `additionalProperties`). Walks the tree by default and reports every failure. |
| `packages/inventory/index.mjs` | Writes `index.yaml`: one entry per recipe with `name`, `artifactName`, `container`, `model`, `description`, `recipe_version`, `engines`, `solo_only`, `cluster_only`, `min_nodes`, `artifactRef` and `path`. Generated, not committed. |
| `packages/publish/index.mjs` | Builds the `ds porter` manifest and pushes. Per-recipe annotations carry the metadata spark-pulse's OCI browser reads without pulling any YAML. |

Artifact names come from the path below `recipes/`, with `/` replaced by `-`,
because three different recipes share the basename
`qwen3.5-397b-int4-autoround.yaml`.

### CI

`validate.yml` runs the validator, the inventory and a publish dry-run on every
pull request. `publish.yml` runs semantic-release on `main` and, when a release
is cut, validates, regenerates `index.yaml` and pushes the collection to
`ghcr.io`.

## Adding a recipe

1. Write `recipes/<name>.yaml` (or `recipes/<Nx-spark-cluster>/<name>.yaml` if
   it needs a fixed node count) in v2.
2. Put only genuinely engine-neutral values in `params`; everything else goes
   under `engines.<engine>`.
3. Add an `engines.sglang` block only if the recipe would really run there —
   and say in a comment what you have not verified.
4. `node packages/validate/index.mjs`.
5. Cross-check against the real parser, which is the authority:
   ```bash
   cd ../spark-pulse && .venv/bin/python -c \
     "from spark_pulse.tools.recipe_schema import validate_recipe_dir; \
      print([r for r in validate_recipe_dir('../spark-pulse-recipes/recipes') if not r['ok']])"
   ```
   A recipe this repo's validator accepts but spark-pulse rejects is a bug.
