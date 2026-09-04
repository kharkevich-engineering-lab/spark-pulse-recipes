# Recipe schemas

These three files are **copied verbatim** from
[`spark-pulse`](https://github.com/kharkevich-engineering-lab/spark-pulse),
which owns the recipe format:

| File | Source in spark-pulse |
|---|---|
| `recipe.schema.json` | `spark_pulse/schemas/recipe.schema.json` |
| `recipe-v1.schema.json` | `spark_pulse/schemas/recipe-v1.schema.json` |
| `recipe-v2.schema.json` | `spark_pulse/schemas/recipe-v2.schema.json` |

Do not edit them here. Change them in `spark-pulse` (where
`spark_pulse/tools/recipe_schema.py` is the matching in-process parser) and
copy the result back into this directory.

`recipe.schema.json` is the entry point: it is a `oneOf` over the two
versioned schemas, dispatching on `recipe_version` (absent or `"1"` is v1,
`"2"` is v2). The per-version files are referenced by `$id`, so a validator
must resolve `$ref` through a registry keyed on `$id` rather than by fetching
the URLs — that is what `packages/validate/index.mjs` does.
