# Repository Instructions

Before changing Valutio, read:

1. `MAINTAINER_GUIDE.md`
2. `Rules/CONTRIBUTING.md`
3. `PUBLISHING.md` when preparing a release

The maintainer guide records the wallet schema, financial formulas, data
invariants, migration rules, import/export guarantees, localization and theme
rules, security boundaries, tests, and release workflow.

Non-negotiable working rules:

- Edit only `Valutio-source`, never generated public or deploy output.
- Preserve closed snapshots, archived tax sources, exact transaction ordering,
  decimal-string fidelity, and the FX rate convention.
- Add deterministic tests for any calculation or persisted-data change.
- Keep English and Italian, plus dark, light, and dim themes, functionally
  equivalent.
- Run the required checks in `MAINTAINER_GUIDE.md` before publishing.
- Update `MAINTAINER_GUIDE.md` in the same change when documented behavior,
  schema, formulas, limitations, or workflow changes.

If code and documentation differ, inspect the implementation and tests, resolve
the discrepancy, and update both. Do not guess at financial behavior.
