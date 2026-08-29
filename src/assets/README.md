# Drop the Rive export here as `avatar.riv`.

**Making the file: see [`RIVE_BUILD_BRIEF.md`](../../RIVE_BUILD_BRIEF.md)** — the
step-by-step recipe, including the prompts for Rive's AI Agent.

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

The names are **case-sensitive**. They resolve through **data binding first**,
falling back to state-machine inputs of the same name. Either authoring style
works; authoring both is the safest.

Two structural requirements, because the app names neither: the avatar artboard
must be the file's **default artboard**, and it should carry **exactly one state
machine**.

Verify after dropping it in: the popover's provenance row should read
`rive 4/4 inputs`. Anything less is named in the DevTools console.

The `.riv` itself is gitignored for now.
