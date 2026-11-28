# 0212. The iPhone Duo: one phone app that adapts to both screens

- Status: Accepted
- Date: 2026-11-20
- Code: side insets `useSideInsets` in `apps/mobile/src/ui/navigation.tsx` (the screen option presets);
  orientation `apps/mobile/src/lib/orientation.ts` (`homeOrientation`, `followScreens`, `holdOrientation`, used by
  `src/features/computer/useSideways.ts`); two panes `src/ui/two-pane.ts` (`paneFrames`, `WIDE_MIN`) and
  `src/ui/TwoPane.tsx` (`TwoPane`, `useWide`, `DuoProvider`, mounted in `src/providers/AppProviders.tsx`); the window's
  fold and what floats over a whole screen `src/ui/fold-room.ts` (`foldRoom`, `besideFold`, `padPastFold`,
  `toastInsets`) read through `useWindowFold` and `useFoldRoom` (`src/ui/TwoPane.tsx`); the native module
  `apps/mobile/modules/duo-layout` (`DuoRegionsView`); the iOS build `.github/workflows/ios.yml`; tests
  `apps/mobile/test/two-pane.test.ts`, `apps/mobile/test/fold-room.test.ts`; the list-and-detail splits
  `src/features/shared/split-store.ts` and `src/features/shared/SplitPanes.tsx`, used by `features/chats/ChatsSplit.tsx`
  (Conversations, Threads), `features/agents/AgentsSplit.tsx`, `features/me/MeScreen.tsx` and
  `features/settings/SettingsScreen.tsx` (tests `apps/mobile/test/features/*-split.test.ts`, `split-store.test.ts`)

## Context

The iPhone Duo folds. Closed, the app runs on its outer display, a phone screen whose side controls sit along one
edge. Open, it runs on the inner display, as wide as a small tablet; partially folded like a book, the curve through
the middle of that display reads poorly and is hard to tap, and iOS describes it as a reserved region of the
"division" kind. The phone app was made for one portrait phone screen: locked upright, one pane at a time, and with
nothing kept clear of a display's sides.

## Decision

1. **One app that adapts, by size class.** Compact width (the outer display, every other iPhone) shows the app as it
   was; regular width (the inner display) shows more of it. No feature depends on a pose (book, tabletop, tent) or on
   the hinge's angle, so everything works the same way on whichever screen, and on Android's large screens too.
2. **Side insets in the screen presets.** The option presets every stack uses (`usePushedOptions`, the tabs' large
   title options, the first run's and the links' screens) pad the content by the window's left and right safe-area
   insets (`useSideInsets`), while its background still fills behind them: the outer display's side controls, a notch
   in landscape. A screen that places its own controls by those insets (an agent's computer) takes none from the
   preset.
3. **Free orientation on a large screen.** The app stays upright on a phone's screen and turns freely on a screen
   whose shortest side is 600 points or more (`LARGE_SCREEN`), which people hold and set down every way; opening or
   closing the device moves the app to the other screen's rule. A screen that holds an orientation of its own (the
   agent's computer, ADR 0098) keeps it while it shows. The same rules make the app an iPad app (`ios.supportsTablet`,
   every orientation, Split View): an iPad is a large screen with no fold, so it gets the free orientation and the two
   panes by its window's width, and the Mac runs the iPad app in a window that resizes. On any large width a screen's
   content keeps to a readable column (`READABLE_MAX`, 720 points, `useReadableSide` of its window or pane), its sides
   opening into margins while a cover's sky still runs edge to edge.
4. **Two panes on regular width, split at the fold.** Screens that are a list and its detail (Conversations, Threads,
   Agents, You and the workspace's settings) show both side by side on a regular-width window, as on the web, each on
   the same pieces (`SplitPanes`: the detail drawn afresh per item inside its own error boundary; `PageSplitScreen` for
   a pushed screen that lists pages); its row stays lit while its item shows, and a row that opens anything else still
   pushes it. With nothing chosen, Conversations and Threads open their first conversation; Agents, You and the
   settings show their first page without choosing it (an agent, Notifications, the first section), and Threads and
   Agents say so in a quiet line when the list is empty. The list takes 40% of the width, from 300 to 380 points, then
   a hairline, then the detail. When the device is folded like a book, the split moves so the fold falls between the
   panes: the list ends where the fold's region starts and the detail starts where it ends, with nothing in the curve
   (`paneFrames`). Each pane clips its content. A fold at an edge of the row or outside it divides nothing, and a fold
   across the panes (the device folded like a laptop) leaves the split as it is: lists and conversations scroll across
   it, as the system's own lists do.
5. **A small native module reads the fold and the size class**, since React Native exposes neither the reserved
   regions nor the size class. `modules/duo-layout` is a local Expo module, iOS only, with one transparent view nobody
   can touch (`DuoRegionsView`). It reads `reservedRegions(kind: .division, options: .includeInactive)` in
   `updateConstraints()`, where UIKit tracks the regions read and runs it again when they change, picks the first
   region taller than wide that crosses the view, and sends `onRegions` (`{ wide, fold: { x, y, width, height, active }
   | null }`, in the view's own points) only when the size class or that region changed. One such view fills the root
   for `useWide` and `useWindowFold` (the fold in the window's points: where it is, `active`, and `hasFold` for a
   decision that should hold as the device bends); each `TwoPane` has its own, so the fold comes in the row's own
   points. Only an active region moves anything. Where there is no module (Android, a build from before) or before it
   reports, the window's width decides: two panes from 600 points (`WIDE_MIN`), and no fold.
6. **The system's own pieces wherever they exist.** Navigation stays the system's stacks, tabs, sheets and menus, and a
   screen's header buttons are native header items, so the system keeps them clear of the outer display's side
   controls and moves its presentations around the fold; the app reads regions only for what it lays out itself: the
   two panes, and what floats over a whole screen (10).
7. **A screen shown in a pane draws its own bar.** A pane is not a navigation screen, so `PushedHeader` asks `usePane()`:
   outside a pane it sets the native header as before; inside one (`Pane`, `usePaneHeader`) the pane draws the same
   title, line and actions as our icon buttons in one capsule, with no back button (the list is beside it), and gives
   the screen its width and bar height. Any screen built on `PushedHeader` can be a detail pane without changes. A
   pushed screen shown as two panes (You, the settings) hides its own bar, and its list's pane bar holds the way back
   (`PaneBackContext`). A page done in a detail pane (a form saved) is drawn afresh in place instead of going back
   (`useLeavePage`), and a form with changes not saved asks before another row replaces it, as back does
   (`useUnsavedGuard`, `useSplitGuard`).
8. **Opening and closing keeps the place.** What each split shows is kept per workspace
   (`src/features/shared/split-store.ts`, `createSplitStore`): the person's choice, and what shows while there is none
   (`offer`), which is never pushed. Folding to the narrow screen pushes the choice as a page, in place (`stillHref`;
   the main stack drops that mark once the page is up, so going back slides); unfolding with one of a split's pages on
   top moves it into the split (`splitHandoff`, `useSplitHandoff`): a conversation or an agent's page from the tab
   selected under it (Threads takes what was pushed from Threads, Conversations any other conversation), a page of You
   or of the settings when it stands right over its screen (`routeAbove`). The draft stays (the composer's own store)
   and so does the message read last (`reading-place.ts`), which the next screen opens at without a highlight: the
   same message, not the exact pixel. A form's unsaved changes do not cross over.
9. **Xcode 27 for the iOS 27.1 SDK.** The reserved regions are iOS 27.1 API, in the SDK of Xcode 27.1 (Swift 6.4), so
   the iOS build runs on an Xcode 27 runner and takes its newest Xcode. The call is behind `#if compiler(>=6.4)` and
   `if #available(iOS 27.1, *)`: an older Xcode builds the view without it (no fold, the size class still read), and
   iOS before 27.1 runs it the same way.
10. **What floats over a whole screen keeps to one side of the fold, moved as little as it can be.** Folded like a
    book, the curve takes the middle of a screen that is not split, where the app centers what floats over it.
    `useFoldRoom` gives the side past the window's active fold (`foldRoom`: the trailing side, the leading one only
    when it is the wider), and nothing inside two panes, which keep to one side already. What comes and goes stands in
    the middle of that side, where the guidance sends it since it keeps appearing there as the device closes: the
    toast (`toastInsets`, its width capped to the half), the notice island (unless it grows out of the camera), the
    conversation's date and welcome card, the picture viewer's hint. A control centered on the screen moves beside the
    fold (`besideFold`): a live file's island, the canvas's tools and pen, the computer's capsule. A bar across the
    screen keeps its controls to that side while its background still spans the screen (`padPastFold`): the composer
    of a conversation shown over the whole window, a file's conversation line, the picture viewer's actions, the
    slideshow's controls, the wiki's bars, a widget's field, the effort's ramp. Controls at the screen's edges, content
    that scrolls under the curve and the system's own presentations stay as they are, and nothing changes without an
    active fold: flat, on the outer display or on a phone.

## Consequences

- The module reaches phones only with a new native build; the JavaScript falls back to the window's width until then.
- Xcode 27.0 has Swift 6.4 but not the iOS 27.1 SDK, so it can't build the module: the iOS build needs Xcode 27.1 or
  later. Xcode 26.4 to 26.6 have Swift 6.3, which the check leaves out.
- On Android a large screen gets two panes by its width, with no fold read; a native fold reader there is a separate
  decision.
- A new list-and-detail screen adopts `TwoPane` and `useWide` rather than measuring the window or the fold itself; a
  new control floating over a whole screen reads `useFoldRoom`.
- A grid that takes its column count from its width rounds it to an even number where the window has a fold
  (`useWindowFold().hasFold`, never fewer than two), so the fold falls between columns and nothing reshuffles as the
  device bends. The app's grids today have fixed even counts (Drive and a dashboard two, the stickers four).
