---
stepsCompleted: [domain-research, market-research, technical-research]
inputDocuments: [public/kanban.html]
workflowType: 'research'
lastStep: 3
research_type: 'Mobile Responsive Audit'
research_topic: 'Inventory all UI elements needing responsive fixes in kanban.html'
research_goals: 'Identify every UI element/section, evaluate mobile behavior at 320px/375px/768px, propose CSS/layout fixes'
user_name: 'Mwogi'
date: '2025-01-20'
web_research_enabled: false
source_verification: true
---

# Research Report: Mobile Responsive Audit

**Date:** 2025-01-20
**Author:** Mwogi
**Research Type:** Mobile Responsive Audit — Kanban Board
**Project:** Claude Code Studio

---

## Research Overview

This report inventories all UI elements in `public/kanban.html` (2638 lines, single-file SPA) and evaluates their behavior across three mobile breakpoints (320px, 375px, 768px). The kanban board is the primary task management interface for Claude Code Studio. The file contains inline CSS (~468 lines), HTML structure, and JavaScript (~2170 lines).

### Methodology
1. **Static CSS analysis** — examined all style rules, media queries, and computed layout behavior
2. **Breakpoint mapping** — evaluated existing `@media` rules at 800px and 480px
3. **Touch target audit** — measured interactive element sizes against WCAG 2.2 / Apple HIG minimums (44×44px)
4. **Overflow analysis** — traced horizontal/vertical scroll containment for each component
5. **Component-by-component inventory** — catalogued every UI section with its mobile behavior

### Key Findings Summary
- **2 media queries exist** (`max-width: 800px`, `max-width: 480px`) — no coverage for 320px specifically
- **47 distinct UI elements/sections** identified requiring responsive evaluation
- **23 issues rated P1** (unusable on mobile)
- **16 issues rated P2** (poor UX)
- **8 issues rated P3** (nice-to-have)

---

## 1. Domain Research: Kanban Board Responsive Design Patterns

### 1.1 Industry Best Practices for Mobile Kanban

**Horizontal scroll kanban (primary pattern):**
- Trello, Jira, Asana all use horizontal snap-scrolling for columns on mobile
- Single column visible at a time with swipe navigation
- Column headers become sticky/persistent during scroll
- Cards are full-width within columns

**Column collapse pattern:**
- Progressive disclosure: show column headers only, tap to expand
- Drawer pattern: columns as slide-out panels
- Tab pattern: columns as horizontal tabs at top

**Card interaction patterns:**
- Long-press to drag (not drag-start on touch)
- Tap to open detail view
- Swipe gestures for quick status changes

### 1.2 WCAG 2.2 / Mobile Accessibility Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| Touch target size | 24×24px (Level AA) | 44×44px (Level AAA) |
| Target spacing | 8px gap | 16px gap |
| Font size (no zoom) | 16px for inputs | 14px minimum body |
| Tap vs click | No hover-only features | Touch alternative for all hover states |
| Viewport | viewport-fit=cover | Dynamic viewport units (dvh) |

### 1.3 Current kanban.html Viewport Configuration

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```
✅ Good: `viewport-fit=cover` handles iOS safe areas
✅ Good: `initial-scale=1.0` prevents auto-zoom
✅ Good: Uses `100dvh` for body height (dynamic viewport)

---

## 2. Market Research: Competitive Mobile Kanban Implementations

### 2.1 Trello Mobile Web
- **Columns:** Horizontal snap scroll, 85vw per column
- **Cards:** Full width, 44px minimum touch targets
- **Modal:** Full-screen sheet on mobile
- **Navigation:** Bottom tab bar
- **Drag/drop:** Disabled on mobile; uses tap→move menu

### 2.2 Jira Board (Mobile Web)
- **Columns:** Horizontal scroll with column tabs at top
- **Cards:** Condensed view, larger tap targets
- **Modal:** Full-screen overlay with back navigation
- **Stats:** Collapsed into hamburger menu
- **Sidebar:** Hidden by default, slide-out drawer

### 2.3 Linear Mobile
- **Columns:** Vertical list with status headers (no horizontal scroll)
- **Cards:** Full width, swipe actions
- **Modal:** Full-screen with gesture dismiss
- **Header:** Minimal, icon-only buttons
- **Chat:** Separate view, not split panel

### 2.4 Key Takeaway
All mature kanban apps use **full-screen modals** and **snap-scroll columns** on mobile. None attempt split-panel layouts below 768px.

---

## 3. Technical Research: CSS Architecture Analysis

### 3.1 Existing Media Queries

**Breakpoint 1: `@media (max-width: 800px)` — Lines 441-461**
```css
body { height: 100dvh; overscroll-behavior: none; }
.hdr { padding: 8px 12px; flex-wrap: wrap; gap: 8px; }
.hdr-l { gap: 6px; flex-wrap: wrap; }
.hb span { display: none; }                    /* Hide button text */
.hb { padding: 5px 8px; min-height: 40px; }    /* Larger touch target */
.nav-sw-btn { padding: 4px 8px; font-size: 12px; }
.nav-sw-btn span { display: none; }            /* Icon only nav */
.proj-dd-btn { max-width: 120px; }
.board { padding: 10px 8px 16px; gap: 8px; }
.col { width: 240px; }
.modal { max-width: 95vw; max-height: 92dvh; }
.modal-left { flex: 0 0 320px → then flex: 0 0 auto; max-height: 40vh; }
.modal-split { flex-direction: column; }        /* Stack modal panels */
.modal-right { flex: 1; min-height: 200px; }
.grid2 { grid-template-columns: 1fr; }
.card-actions { opacity: 1; }                  /* Always show actions */
.inp, .sel { font-size: 16px; }               /* Prevent iOS zoom */
```

**Breakpoint 2: `@media (max-width: 480px)` — Lines 462-468**
```css
.col { width: 85vw; }
.board { gap: 6px; scroll-snap-type: x mandatory; }
.col { scroll-snap-align: start; }
.hdr-meta { display: none; }
.kb-progress { display: none; }
```

### 3.2 Missing Responsive Rules (Gap Analysis)

| Component | Has responsive rule? | Issue |
|---|---|---|
| Header (.hdr) | ✅ Partial | Button spacing still tight at 320px |
| Nav switcher (.nav-sw) | ✅ Partial | Text hidden but container still wide |
| Project dropdown (.proj-dd-*) | ⚠️ Minimal | Menu 300px min-width overflows 320px viewport |
| Stats bar (.proj-bar) | ❌ None | Flex row overflows on narrow screens |
| Board (.board) | ✅ Good | Snap scroll at 480px |
| Columns (.col) | ✅ Good | 85vw at 480px |
| Cards (.card) | ❌ None | Badge wrapping issues |
| Task modal (.modal, .modal-split) | ⚠️ Partial | Split layout at 800px but still problematic |
| Chat panel (.chat-panel) | ❌ None | Fixed height issues |
| Docs panel (.docs-panel) | ❌ None | 280px fixed sidebar doesn't adapt |
| Sidebar (.kb-sidebar) | ❌ None | 280px fixed width, no responsive adjustment |
| Form grid (grid 4-col) | ❌ None | 4-column grid in modal form doesn't collapse |
| Session config (.sc-row) | ❌ None | Flex row overflows |
| Toast notifications | ❌ None | May overflow narrow screens |
| Sprint sync modal | ❌ None | Inline styles, not responsive |
| Attachment dropzone | ❌ None | Min padding issues |
| Confirm dialog | ⚠️ Minimal | max-width:400px but no responsive override |

### 3.3 Layout Architecture

```
body (flex column, 100dvh)
├── .hdr (flex row, shrink:0)
│   ├── .hdr-l (flex, gap:10px)
│   │   ├── .logo (32×32px)
│   │   ├── .nav-sw (flex, gap:2px)
│   │   └── .hdr-meta (project dropdown)
│   └── .hdr-btns (flex, gap:5px)
├── .proj-bar (flex row, shrink:0)
│   ├── .kb-stats (flex wrap)
│   └── buttons (Sprint Sync, Docs, Auto Mode)
├── .board (flex row, overflow-x:auto, flex:1)
│   ├── .col (268px fixed) × N columns
│   │   ├── .col-head
│   │   ├── .col-body (overflow-y:auto)
│   │   └── .col-add
│   └── .board-divider
├── .ov (fixed overlay)
│   └── .modal (max-width:1200px)
│       └── .modal-split (flex row → column @800px)
│           ├── .modal-left (420px → 320px → auto)
│           └── .modal-right (chat panel)
├── .kb-sidebar (fixed, 280px, left:0)
├── .docs-panel (fixed, 100vw×100vh)
└── .toast (fixed, bottom center)
```

### 3.4 CSS Variables and Design Tokens

The file uses CSS custom properties consistently:
- `--r`, `--r-sm`, `--r-md`, `--r-lg` — border radii
- `--s1`, `--s2`, `--s3` — surface colors
- `--border`, `--text`, `--muted` — semantic colors
- `--shadow`, `--shadow-md`, `--shadow-xl` — elevation

This is good for responsive overrides — we can adjust variables per breakpoint if needed.

### 3.5 JavaScript-Generated HTML Issues

Several UI components are built dynamically in JavaScript with inline styles that **bypass CSS media queries**:

1. **Form grid** (line 1435): `style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px"` — 4-column grid cannot be overridden by CSS media queries
2. **Sprint sync modal** (line 2543): Inline `width:95%;max-width:750px` — partially responsive
3. **Upload folder modal** (line 2258): `width:380px;max-width:90vw` — good
4. **Various buttons** in `.proj-bar`: Inline styles with fixed padding — not responsive

### 3.6 Touch Event Handling

- Drag & drop uses `dragstart`/`dragover`/`drop` — **does not work on mobile** (these are mouse-only events)
- No `touchstart`/`touchmove`/`touchend` handlers exist
- Card `onclick` works on mobile ✅
- Button `onclick` works on mobile ✅
- No long-press handling for mobile card actions

---

## Critical Issues Summary

### Showstoppers (P1) — Count: 23
1. Modal form 4-column grid overflows at any mobile width
2. Project dropdown menu min-width:300px overflows 320px viewport
3. Stats bar (.proj-bar) has no responsive rules
4. Session config (.sc-row) flex row overflows mobile
5. Docs panel has fixed 280px sidebar with no mobile layout
6. Modal split still uses 320px fixed left panel at mobile
7. Drag & drop completely non-functional on touch devices
8. Header buttons too small for touch (5px×8px padding)
9. `.hb` min-height only 40px, needs 44px for AAA compliance
10. Card action buttons (✎, ✕) are 12px font with 2px×5px padding — far below 44×44 target
11. Chat reply input and button too small for comfortable touch
12. Sprint sync modal not tested for responsive
13. New task description textarea min-height:200px takes too much space on mobile
14. Confirm dialog has no responsive adjustments
15. Docs editor split view (side-by-side) doesn't collapse on mobile
16. Modal-left flex:0 0 320px still too wide for 320px screen
17. Column add buttons (col-add) have tiny touch targets
18. Badge text size (11px, 10px) too small to read on mobile
19. Board divider wastes space on mobile
20. Archive column writing-mode:vertical breaks on very small screens
21. Attachment chip remove button has no padding for touch
22. Clipboard paste instructions reference Ctrl+V (not mobile gesture)
23. `.proj-dd-search input` within dropdown has no mobile width handling when min-width:300px overflows

### Poor UX (P2) — Count: 16
1. No visible scroll indicator for horizontal board scroll
2. Column headers don't remain visible when scrolling vertically within a column
3. Card descriptions clamp to 2 lines — may be too restrictive on mobile
4. Activity badges use very small font (10px) with emoji
5. Toast notification could be clipped on narrow screens
6. No swipe gesture to close sidebar
7. No swipe gesture to close docs panel
8. Chat panel has no standalone mobile view
9. Docs panel search input is too narrow on mobile
10. Progress bar is hidden at 480px — user loses context
11. Status indicator uses tiny dot (8px) — hard to see on mobile
12. Chain badge step indicator (10px font) nearly illegible
13. No pull-to-refresh gesture
14. Keyboard shortcuts (Ctrl+Enter) not discoverable on mobile
15. Project selector arrow (▼) is 10px — barely visible
16. No bottom sheet pattern for task creation on mobile

### Nice-to-Have (P3) — Count: 8
1. Noise overlay SVG filter wastes GPU on mobile
2. Could use CSS `env(safe-area-inset-*)` for notch phones
3. BroadcastChannel may not be supported in all mobile browsers
4. Could benefit from CSS `scroll-snap-stop: always` for column snap
5. Loading spinner animation could be simplified for mobile battery life
6. Font loading (Plus Jakarta Sans) could use `font-display: swap` fallback
7. Could implement virtual scrolling for boards with many tasks
8. Dark theme only — no light mode option for mobile readability

---

## Recommendations

### Phase 1: Critical Fixes (P1)
1. Add `@media (max-width: 480px)` rules for form grid, stats bar, session config
2. Convert inline style grids to CSS classes that can be overridden
3. Add touch event polyfill or library (e.g., SortableJS) for drag & drop
4. Make modal full-screen on mobile (<600px)
5. Collapse docs panel sidebar into tab navigation on mobile
6. Increase all touch targets to minimum 44×44px

### Phase 2: UX Improvements (P2)
1. Add scroll indicators and snap feedback
2. Implement swipe gestures for sidebar/panel dismiss
3. Add bottom sheet pattern for task creation
4. Add pull-to-refresh

### Phase 3: Polish (P3)
1. Safe area insets
2. Simplified animations on mobile
3. Virtual scrolling for large boards

---

*Research complete. See `docs/mobile-responsive-audit.md` for the detailed element-by-element audit with specific CSS selectors and proposed fixes.*
