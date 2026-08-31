# terroir support

This fork adds [terroir](https://github.com/f0rk/terroir) support to the
HashiCorp Terraform extension. terroir renders every `.tf` file as a Jinja2
template before running terraform, so on disk they are templates, not HCL —
which breaks highlighting, `terraform fmt`, and every terraform-ls diagnostic
below the first Jinja tag.

## What it does

- Highlights Jinja inside HCL, including `{{ }}` in a string that itself
  contains double quotes.
- Suppresses `terraform fmt` on templated files, which cannot parse them.
- Renders each file with real terroir and hands the result to terraform-ls, so
  diagnostics, hover and completion see valid HCL. Diagnostics are mapped back
  to the line you are looking at.

Nothing is written to disk. terroir's own `.tfbak` write-and-restore path is
never invoked.

## Requirements

A `python3` that can `import terroir`, and a workspace with a `.terroir`
directory. Without either, the extension behaves exactly like upstream.

## Settings

| Setting | Default | |
|---|---|---|
| `terraform.terroir.enable` | `true` | master switch |
| `terraform.terroir.render.enable` | `true` | feed rendered HCL to terraform-ls |
| `terraform.terroir.environment` | `staging` | `CAPITALRX_ENVIRONMENT` to render for |
| `terraform.terroir.pythonPath` | `python3` | interpreter that can import terroir |
| `terraform.terroir.renderDebounceMs` | `350` | delay before re-rendering while typing |
| `terraform.terroir.formatGuard.enable` | `true` | suppress `terraform fmt` on templates |

## Commands

`Terroir: Select Environment`, `Terroir: Show Rendered Template`,
`Terroir: Restart Render Worker`.

## Staying close to upstream

Everything lives in `src/terroir/`, `python/`, `syntaxes-custom/` and
`terroir-tools/` — paths upstream does not use. Upstream files carry three
added lines in `src/extension.ts` and three array appends in `package.json`.
`terroir-tools/upstream-diff.sh` prints exactly that drift; keep it small.
