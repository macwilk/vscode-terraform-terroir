# terroir support

This fork adds [terroir](https://github.com/f0rk/terroir) support to the
HashiCorp Terraform extension. terroir renders every `.tf` file as a Jinja2
template before running terraform, so on disk they are templates, not HCL —
which breaks highlighting, `terraform fmt`, and every terraform-ls diagnostic
below the first Jinja tag.

## What it does

- Highlights Jinja inside HCL, including `{{ }}` in a string that itself
  contains double quotes.
- Formats the template itself. Jinja is masked into placeholders that are valid
  HCL where they sit, `terraform fmt` runs over that, and the Jinja goes back.
  No render and no environment are involved, so branches the current environment
  does not take are formatted too. Each conditional branch is formatted with the
  others suppressed, because `terraform fmt` rejects the same attribute defined
  twice. Block bodies are then indented one level inside their tags.
  Every result is checked against the input: same Jinja spans byte for byte, and
  the literal between them differing only in whitespace. Anything else is
  discarded and the file is left alone. Where the terraform binary is missing,
  formatting falls back to the language server over the rendered file.
- Renders each file with real terroir and hands the result to terraform-ls, so
  diagnostics, hover and completion see valid HCL. Diagnostics are mapped back
  to the line you are looking at.

Nothing is written to disk. terroir's own `.tfbak` write-and-restore path is
never invoked.

## Requirements

Python 3.9 or newer, and a workspace with a `.terroir` directory. terroir and
its dependencies are bundled in `python/vendor`, so nothing needs installing —
a system interpreter is enough, which matters because a GUI-launched editor
does not inherit a login shell's PATH. An installed terroir takes precedence
over the bundled copy. Without a usable Python or a `.terroir` directory, the
extension behaves exactly like upstream and says so.

## Settings

| Setting | Default | |
|---|---|---|
| `terraform.terroir.enable` | `true` | master switch |
| `terraform.terroir.render.enable` | `true` | feed rendered HCL to terraform-ls |
| `terraform.terroir.environment` | `staging` | `CAPITALRX_ENVIRONMENT` to render for |
| `terraform.terroir.pythonPath` | discovered | interpreter to render with; any Python 3.9+ |
| `terraform.terroir.renderDebounceMs` | `350` | delay before re-rendering while typing |
| `terraform.terroir.format.indentBlocks` | `true` | indent block bodies one level inside their tags |
| `terraform.terroir.terraformPath` | `terraform` | binary used to format templates |
| `terraform.terroir.environmentByPath` | `{}` | per-stack environment overrides, longest matching path fragment wins |
| `terraform.terroir.formatGuard.enable` | `true` | only replay `terraform fmt` edits that cannot touch Jinja (fallback path) |

## Commands

`Terroir: Select Environment`, `Terroir: Show Rendered Template`,
`Terroir: Restart Render Worker`.

## Staying close to upstream

Everything lives in `src/terroir/`, `python/`, `syntaxes-custom/` and
`terroir-tools/` — paths upstream does not use. Upstream files carry three
added lines in `src/extension.ts` and three array appends in `package.json`.
`terroir-tools/upstream-diff.sh` prints exactly that drift; keep it small.
`terroir-tools/vendor-python.sh` regenerates `python/vendor`.
