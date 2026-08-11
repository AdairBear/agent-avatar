# Track 1 drops the Rive export here as `avatar.riv`.

Asset presence is what switches the renderer from placeholder to Rive — there
is no config flag. See `docs/ARCHITECTURE.md` §2 and `src/core/rive-contract.ts`
for the three required state-machine input names.

The `.riv` itself is gitignored for now.
