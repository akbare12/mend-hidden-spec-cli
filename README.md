# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/akbare12/mend-hidden-spec-cli/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/akbare12/mend-hidden-spec-cli/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. `mend` reads all
four to one written specification (`SPEC.md`), finds the lines an edit names even
when the model drifted their whitespace or indentation (three matching tiers), and
changes every file or none.

Node 22 and its standard library alone. Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`SPEC.md` is the whole contract. `runner.ts` is the kit's trial runner (kept as
shipped); `check.ts` runs the public practice set on your own machine:

    node check.ts ../program/generator/practice.json
