# Drop the Rive export here as `avatar.riv`.

Asset presence is what switches the renderer from placeholder to Rive — there
is no config flag. Rebuild (`npm run build`) after dropping it in.

The artboard must expose these four names. See `src/core/rive-contract.ts` for
the machine-readable version, and the README's "Dropping in the `.riv`" section
for the full contract.

| Name | Type | Range |
|---|---|---|
| `nourishment` | number | 0–100 |
| `energy` | number | 0–100 |
| `isWorking` | boolean | — |
| `celebrate` | trigger | — |

The numbers resolve through **data binding first**, falling back to
state-machine inputs of the same name. Either authoring style works.

The `.riv` itself is gitignored for now.
