# adaptive-drive-to-sheet eval harness

These files define optional ADK eval coverage for the `app/` wrapper around the
adaptive-drive-to-sheet Node pipeline.

The production workflow currently runs through Claude/Codex and the Node tools,
so Gemini API credentials are not required for normal operation. Use the Node
gates first:

```bash
npm test --prefix tool
node tool/test-smoke.js
node tool/sync-many.js --list-changes --run-id preflight-YYYYMMDD
```

Only run ADK eval when you intentionally test the `agents-cli`/Gemini wrapper
and have configured the required Google model credentials:

```bash
agents-cli eval run --evalset tests/eval/evalsets/adaptive_drive_to_sheet_core.json --config tests/eval/eval_config.json
```

Do not lower thresholds to make regressions pass. Fix the agent instructions or
tool behavior first, then rerun the eval.
