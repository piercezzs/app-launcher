# Paper-minimal mode

Hatch provides Standard and Minimal interfaces over the same
application-local launcher state. Choose the mode in Settings. Profiles without a saved mode start in Minimal. An explicitly saved Standard
selection remains Standard after an update.

Minimal uses the original Hatch paper texture and warm palette with one icon
catalog, search, All / Pinned / Recent tabs and an independent group filter. Search
still matches names, notes and paths. Missing entries open their details and
recovery actions rather than launching a fallback target. Hidden entries remain
excluded.

App menus expose information, edit, reveal, pin and hide/remove. The global More
menu exposes return to Standard, add, group management, hidden applications,
rescan, sorting and Settings. Hidden-app management opens the existing Standard
view. Existing editing, group and removal dialogs are reused; the update workflow
is unchanged.

## Preference and state boundaries

- `src/interface-mode.ts` owns the `hatch.interface-mode` local WebView preference.
  Invalid or unavailable storage defaults to Minimal. A failed write preserves
  the current session selection and shows a warning in Settings.
- Switching mode does not reload discovery, rewrite records or alter groups,
  pins, paths or launch history. Search and sort remain shared. When returning
  to Standard, a combined minimal tab/group filter is represented by the tab
  when it is Pinned or Recent, or by the group when the tab is All, because the
  Standard sidebar supports one category at a time.
- Mode switching is disabled during application/group editing, pending removal
  confirmation or a save. Existing drafts stay in their current editing surface.
- `src/catalog.ts` owns pure filtering and sorting. A null group filter means all
  groups; an empty group means ungrouped. Hidden visibility is independent from
  pin and recent predicates.
- `src/minimal.css` scopes the compact layout to the minimal shell and uses a
  document mode attribute for portal menus/dialogs. Mode selector styling is
  available in both interfaces.
- Native window decorations remain platform-owned on macOS; Windows retains the
  existing custom window controls. No global keyboard shortcut is introduced.

## Acceptance contract

The approved direction is the paper-minimal B design, with a 980 × 720 base
window and a 560 × 720 narrow case. The catalog is the primary scroll owner;
headers remain fixed. Menus must stay inside the viewport, and dialogs own their
body scrolling and restore focus to a surviving opener or the search field.

Required checks include populated/empty/search states, initial load and retry,
missing-path recovery, app/global/group menus, mode and language switches,
editing/removal/group dialogs, long names, keyboard focus, and persistence after
restart. Existing language and update detail screens retain their prior visual
contracts. The mode feature alone does not establish Windows or Intel Mac
runtime acceptance, installer distribution, signing or notarization.

Run `pnpm check` and `pnpm --filter hatch test` for frontend changes. Native
visual and operation checks use an isolated development application identifier
and test profile. Do not change the production identifier or seed real user
records to validate the interface.

## Development verification — 2026-09-10

- Frontend type checks and production asset build passed; 48 tests across five
  suites passed, including preference failure handling and catalog predicates.
- An isolated macOS debug bundle exercised mode persistence after restart,
  search, empty filters, group and action menus, settings/language switching,
  custom entry creation, missing-path details, editing, pinning, safe local
  directory launch, recent history and removal. Temporary test records were
  removed from the isolated profile.
- Details-to-editor focus and menu action dispatch were corrected from native
  observations and rechecked. The mode settings panel is centered at 440 px.
- Rendered desktop and narrow layouts were compared independently with direction
  B. Full visual acceptance remains open for initial-load/failure/retry/busy
  states and Windows target-host behavior; unit tests do not replace those
  runtime checks. Update-service behavior and distribution are outside this
  interface change's acceptance scope.
