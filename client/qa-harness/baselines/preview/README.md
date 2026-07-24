# Preview-VM baselines (PR harness)

Captured against ephemeral `mog-pr-*` hosts via:

```
QA_TIER=full QA_CLASSES=wizard,paladin,acolyte QA_VIDEO=0 npm run qa:harness -- --pr N --update-baseline
```

Then move the updated files here (do not overwrite root `baselines/*.json`, which are local-GPU feel baselines).

Compare with:

```
QA_BASELINE_DIR=qa-harness/baselines/preview npm run qa:harness -- --pr N
```

Root `baselines/` = local GPU. This directory = preview VM / network feel.
