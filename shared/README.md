# Shared data

## `actions.json`

Canonical **action-pipeline authority** for the game (action defs shared by client and server). After editing this file, regenerate:

```bash
cd client && npm run gen:actions
# check without writing: npm run gen:actions:check
```

See `client/src/content/ART_DROP_IN.md` for the content-drop-in contract (rig, motions, props).
