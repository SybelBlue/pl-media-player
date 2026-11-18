# PL Media Player

A PrairieLearn course with reproducible Python and JavaScript tooling,
vendored shared components, and end-to-end question checks.

## Setup

Install Python 3.13+, [uv](https://docs.astral.sh/uv/),
[pnpm](https://pnpm.io/) 11.19+, GNU Make, and Docker Desktop. Then run:

```sh
make deps
make check
make dev
```

`make deps` installs locked dependencies, enables the advisory pre-push hook,
and synchronizes the vendored trees to `plvendor-lock.yaml`.

## Course layout

```text
courseInstances/    Course instances and assessments
elements/           Course-specific PrairieLearn elements
questions/          Question bank
serverFilesCourse/  Course-wide Python helpers
scripts/            Validation and maintenance tools
```

The starter assessment references `questions/starter/smoke`. Replace or extend
that content as the course is developed.

## Common commands

| Command                      | Purpose                                           |
| ---------------------------- | ------------------------------------------------- |
| `make test`                  | Run helper, element, and question lifecycle tests |
| `make validate`              | Validate JSON, schemas, and HTML/Mustache         |
| `make typecheck`             | Type-check repository Python files                |
| `make format`                | Format Python, JSON, and HTML/Mustache files      |
| `make check`                 | Run the complete local CI contract                |
| `make ci-dryrun`             | Alias for the complete local CI contract          |
| `make vendor-verify`         | Verify vendored trees against the lockfile        |
| `make vendor-check-upstream` | Check for upstream vendor updates                 |
| `make dev`                   | Start the local PrairieLearn development runner   |

## Vendored dependencies

The `[tool.pl-vendor.packages]` tables in `pyproject.toml` define the source and
destination for PrairieLearn schemas and HTMLMustache metadata. Exact revisions
live in `plvendor-lock.yaml`.

Ordinary CI runs `make vendor-verify`; moving upstream branches are checked and
updated separately. Use `make vendor-update-required` to update the two
PrairieLearn-derived packages together.
