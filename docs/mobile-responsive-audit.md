# Mobile Responsive Audit — kanban.html

**Date:** 2025-01-20
**File:** `public/kanban.html` (2638 lines)
**Author:** Mwogi (Analyst Agent)
**Breakpoints Tested:** 320px (small phone), 375px (iPhone SE/standard), 768px (tablet)

---

## Table of Contents

1. [Current State Overview](#1-current-state-overview)
2. [Kanban Columns](#2-kanban-columns)
3. [Task Modal/Dialog](#3-task-modaldialog)
4. [Project Sidebar](#4-project-sidebar)
5. [Header/Toolbar](#5-headertoolbar)
6. [New Task Form](#6-new-task-form)
7. [Chat Panel](#7-chat-panel)
8. [Docs Panel](#8-docs-panel)
9. [Chain Badges/Status Indicators](#9-chain-badgesstatus-indicators)
10. [Touch Targets](#10-touch-targets)
11. [Issue Summary Table](#11-issue-summary-table)
12. [Proposed Implementation Order](#12-proposed-implementation-order)

---

## 1. Current State Overview

### Existing Media Queries

The file has exactly **2 media queries** (lines 441–468):

| Breakpoint | Coverage |
|---|---|
| `@media (max-width: 800px)` | Header, nav, modal split, grid, input zoom fix |
| `@media (max-width: 480px)` | Column width, board snap scroll, hide stats |

**Missing breakpoints:** No rules for 320px, 375px, or 768px specifically.

### What Works on Mobile

| Element | 320px | 375px | 768px | Notes |
|---|---|---|---|---|
| Viewport meta | ✅ | ✅ | ✅ | Correct `viewport-fit=cover` |
| Body height `100dvh` | ✅ | ✅ | ✅ | Dynamic viewport units |
| Board horizontal scroll | ✅ | ✅ | ✅ | `overflow-x:auto` works |
| Column snap scroll | ✅ | ✅ | N/A | Only at ≤480px |
| iOS zoom prevention | ✅ | ✅ | ✅ | `font-size:16px` on inputs |
| Card tap to open | ✅ | ✅ | ✅ | `onclick` handler |
| Toast notifications | ⚠️ | ✅ | ✅ | May clip at 320px |

### What Doesn't Work

| Element | 320px | 375px | 768px | Severity |
|---|---|---|---|---|
| Modal form layout | ❌ | ❌ | ⚠️ | P1 |
| Project dropdown | ❌ | ⚠️ | ✅ | P1 |
| Stats bar | ❌ | ❌ | ⚠️ | P1 |
| Session config | ❌ | ❌ | ❌ | P1 |
| Docs panel layout | ❌ | ❌ | ⚠️ | P1 |
| Drag & drop | ❌ | ❌ | ❌ | P1 |
| Touch targets (many) | ❌ | ❌ | ⚠️ | P1 |

---

## 2. Kanban Columns

### How They Render

| Breakpoint | Column Width | Behavior |
|---|---|---|
| >800px | 268px fixed | Side-by-side, horizontal scroll |
| 480–800px | 240px | Slightly narrower, still scrollable |
| ≤480px | 85vw (272px@320, 319px@375) | Snap scroll, one column at a time |

### Issues Found

#### ISSUE 2.1 — No scroll position indicator
- **Element/selector:** `.board`
- **Current behavior:** Board scrolls horizontally but there's no visual indicator of which column is active or how many columns exist off-screen
- **Proposed fix:** Add scroll indicator dots or a column tab bar at top for mobile
  ```css
  @media (max-width: 480px) {
    .board { scroll-padding: 6px; }
    .board::after { /* scrollbar indicator */ }
  }
  ```
- **Priority:** P2

#### ISSUE 2.2 — Board divider wastes space on mobile
- **Element/selector:** `.board-divider`
- **Current behavior:** 1px divider with 8px margins takes 17px horizontal space between columns
- **Proposed fix:**
  ```css
  @media (max-width: 480px) {
    .board-divider { display: none; }
  }
  ```
- **Priority:** P3

#### ISSUE 2.3 — Column header not sticky during vertical scroll
- **Element/selector:** `.col-head`
- **Current behavior:** Column header scrolls away when column body is long
- **Proposed fix:**
  ```css
  .col-head { position: sticky; top: 0; z-index: 10; }
  ```
- **Priority:** P2

#### ISSUE 2.4 — Archive column writing-mode:vertical-rl at narrow widths
- **Element/selector:** `.col.col-archive:not(.expanded) .col-head`
- **Current behavior:** Vertical text in 44px wide collapsed column. On 320px screen, takes significant percentage of visible area when scrolled to
- **Proposed fix:** Hide archive column by default on mobile, show via overflow menu
  ```css
  @media (max-width: 480px) {
    .col.col-archive:not(.expanded) { width: 36px; }
    .col.col-archive:not(.expanded) .col-head { padding: 8px 4px; }
  }
  ```
- **Priority:** P3

#### ISSUE 2.5 — Column add button tiny touch target
- **Element/selector:** `.col-add`
- **Current behavior:** `padding: 7px` — rendered height ~30px, well below 44px minimum
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .col-add { padding: 12px; min-height: 44px; font-size: 14px; }
  }
  ```
- **Priority:** P1

#### ISSUE 2.6 — Column count badge tiny
- **Element/selector:** `.col-cnt`
- **Current behavior:** 11px font with 1px×7px padding — approximately 20×16px hit area
- **Proposed fix:** Increase size for readability
  ```css
  @media (max-width: 800px) {
    .col-cnt { font-size: 12px; padding: 2px 8px; }
  }
  ```
- **Priority:** P3

---

## 3. Task Modal/Dialog

### Size, Positioning, Scrollability

| Breakpoint | Modal Size | Layout |
|---|---|---|
| >800px | max-width:1200px, max-height:92vh | Side-by-side split (left: form, right: chat) |
| ≤800px | max-width:95vw, max-height:92dvh | Stacked (form top, chat bottom) |
| ≤480px | 95vw ≈ 304px@320, 356px@375 | Same stacked layout, severely cramped |

### Issues Found

#### ISSUE 3.1 — Modal should be full-screen on mobile
- **Element/selector:** `.modal`, `.ov`
- **Current behavior:** `max-width:95vw; max-height:92dvh` with 16px overlay padding. On 320px screen: 304px wide modal with visible overlay behind — wastes screen space
- **Proposed fix:**
  ```css
  @media (max-width: 600px) {
    .ov { padding: 0; }
    .modal { max-width: 100vw; max-height: 100dvh; height: 100dvh;
             border-radius: 0; border: none; }
    .modal.has-chat { min-height: unset; height: 100dvh; }
  }
  ```
- **Priority:** P1

#### ISSUE 3.2 — Modal-left still 320px fixed width at mobile
- **Element/selector:** `.modal-left`
- **Current behavior:** At ≤800px: `flex: 0 0 320px` initially, then overridden to `flex: 0 0 auto; max-height: 40vh`. The 320px is set first but overridden — however `max-height: 40vh` limits form area severely (128px at 320px viewport height ≈ 568px)
- **Proposed fix:**
  ```css
  @media (max-width: 600px) {
    .modal-split { flex-direction: column; }
    .modal-left { flex: 1 1 auto; max-height: none; overflow-y: auto; }
    .modal-right { flex: 0 0 auto; max-height: 50vh; }
  }
  ```
- **Priority:** P1

#### ISSUE 3.3 — Modal header close button small touch target
- **Element/selector:** `.modal-close`
- **Current behavior:** `padding: 2px 6px; font-size: 20px` — approximately 28×24px rendered area
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .modal-close { padding: 8px 12px; font-size: 24px; min-width: 44px; min-height: 44px; }
  }
  ```
- **Priority:** P1

#### ISSUE 3.4 — Modal footer buttons cramped
- **Element/selector:** `.modal-ft`
- **Current behavior:** `padding: 12px 20px` with flex row. On 320px: ~280px usable, 3 buttons (Delete, Cancel, Save) may wrap or overlap
- **Proposed fix:**
  ```css
  @media (max-width: 480px) {
    .modal-ft { flex-wrap: wrap; padding: 12px; gap: 8px; }
    .modal-ft .btn { flex: 1; justify-content: center; min-height: 44px; }
  }
  ```
- **Priority:** P1

#### ISSUE 3.5 — Confirm dialog not responsive
- **Element/selector:** `#confirmOv .modal` (inline `style="max-width:400px"`)
- **Current behavior:** `max-width: 400px` via inline style — overflows 320px viewport. The 95vw override from media query applies to `.modal` class but inline styles have higher specificity
- **Proposed fix:** Move inline style to CSS class, or add `!important`:
  ```css
  @media (max-width: 480px) {
    .modal { max-width: 95vw !important; }
  }
  ```
- **Priority:** P1

---

## 4. Project Sidebar

### Width, Collapse Behavior

| Property | Value |
|---|---|
| Width | 280px fixed |
| Position | `position: fixed; left: 0; top: 0; height: 100vh` |
| Collapse | `transform: translateX(-100%)` when `.collapsed` |
| z-index | 1500 |
| Trigger | CCS logo click → `toggleKbSidebar()` |

### Issues Found

#### ISSUE 4.1 — Sidebar width doesn't adapt to screen size
- **Element/selector:** `.kb-sidebar`
- **Current behavior:** Fixed 280px width. On 320px screen, covers 87.5% of viewport with no visible close area. On 375px, covers 74.7%
- **Proposed fix:**
  ```css
  @media (max-width: 480px) {
    .kb-sidebar { width: 100vw; }
  }
  @media (min-width: 481px) and (max-width: 800px) {
    .kb-sidebar { width: min(280px, 85vw); }
  }
  ```
- **Priority:** P1

#### ISSUE 4.2 — No overlay/backdrop when sidebar is open
- **Element/selector:** `.kb-sidebar` (no overlay exists)
- **Current behavior:** Sidebar opens over content with no backdrop. User can accidentally interact with board behind sidebar
- **Proposed fix:** Add overlay div with click-to-close, or add `pointer-events: none` to board when sidebar is open
  ```css
  .kb-sidebar-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.5);
    z-index: 1499; display: none;
  }
  .kb-sidebar:not(.collapsed) ~ .kb-sidebar-overlay { display: block; }
  ```
- **Priority:** P2

#### ISSUE 4.3 — No swipe-to-close gesture
- **Element/selector:** `.kb-sidebar`
- **Current behavior:** Close button only (×). No swipe left gesture to dismiss
- **Proposed fix:** Add touch event handler for swipe-left dismiss
- **Priority:** P2

#### ISSUE 4.4 — Sidebar session items have tiny touch targets
- **Element/selector:** `.kb-sidebar-sess`
- **Current behavior:** `padding: 6px 16px 6px 36px; font-size: 12px` — approximately 36px tall
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .kb-sidebar-sess { padding: 10px 16px 10px 36px; min-height: 44px;
                       display: flex; align-items: center; }
  }
  ```
- **Priority:** P1

#### ISSUE 4.5 — Sidebar close button small
- **Element/selector:** `.kb-sidebar-hd .modal-close`
- **Current behavior:** `font-size: 16px` inline style — approximately 24×24px
- **Proposed fix:** Increase touch target
  ```css
  @media (max-width: 800px) {
    .kb-sidebar-hd .modal-close { font-size: 24px; padding: 8px; min-width: 44px; min-height: 44px; }
  }
  ```
- **Priority:** P1

---

## 5. Header/Toolbar

### Button Layout, Project Selector

| Breakpoint | Behavior |
|---|---|
| >800px | Full layout: logo + nav + project dropdown + buttons |
| ≤800px | Flex-wrap, text hidden on buttons, nav text hidden |
| ≤480px | hdr-meta hidden (project dropdown disappears!) |

### Issues Found

#### ISSUE 5.1 — Project dropdown hidden at ≤480px
- **Element/selector:** `.hdr-meta`
- **Current behavior:** `display: none` at ≤480px. User **cannot select a project** on small phones! This is a showstopper — adding tasks requires a project selection
- **Proposed fix:** Move project selector out of `.hdr-meta`, or override the hide rule:
  ```css
  @media (max-width: 480px) {
    .hdr-meta { display: flex; } /* Don't hide */
    .proj-dd-wrap { order: -1; } /* Move to prominent position */
    .proj-dd-btn { max-width: 50vw; }
  }
  ```
  Or: Move project selector to its own row below header
- **Priority:** P1 — **CRITICAL: blocks all functionality**

#### ISSUE 5.2 — Project dropdown menu overflows at 320px
- **Element/selector:** `.proj-dd-menu`
- **Current behavior:** `min-width: 300px; max-width: 400px` — at 320px viewport, 300px min-width leaves no margin
- **Proposed fix:**
  ```css
  @media (max-width: 480px) {
    .proj-dd-menu { min-width: unset; width: calc(100vw - 24px);
                    left: -60px; /* Reposition */ max-width: none; }
  }
  ```
- **Priority:** P1

#### ISSUE 5.3 — Header buttons insufficient touch targets
- **Element/selector:** `.hb`
- **Current behavior:** At ≤800px: `padding: 5px 8px; min-height: 40px`. The min-height is 40px but AAA requires 44px. Width depends on content — icon-only buttons may be ~30px wide
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .hb { min-height: 44px; min-width: 44px; justify-content: center; }
  }
  ```
- **Priority:** P1

#### ISSUE 5.4 — Nav switcher too wide for 320px
- **Element/selector:** `.nav-sw`
- **Current behavior:** 3 navigation items (Chat, Kanban, Schedule) with icons + hidden text. Even icon-only, container is ~120px with padding/borders
- **Proposed fix:** Acceptable — 120px out of 320px is reasonable. But could use smaller padding:
  ```css
  @media (max-width: 375px) {
    .nav-sw { padding: 2px; gap: 1px; }
    .nav-sw-btn { padding: 6px; min-width: 40px; min-height: 40px; justify-content: center; }
  }
  ```
- **Priority:** P2

#### ISSUE 5.5 — Header wrapping creates multi-row layout
- **Element/selector:** `.hdr`
- **Current behavior:** `flex-wrap: wrap` at ≤800px. On 320px, nav + logo + buttons may wrap to 3 rows, consuming ~120px of vertical space
- **Proposed fix:** Pin header to single row with overflow handling:
  ```css
  @media (max-width: 480px) {
    .hdr { flex-wrap: nowrap; overflow-x: auto; padding: 6px 8px; }
  }
  ```
- **Priority:** P2

---

## 6. New Task Form

### Input Sizing, Layout

The task form is generated by `buildForm()` (line 1412) with significant inline styles.

### Issues Found

#### ISSUE 6.1 — 4-column grid inline style cannot be overridden by CSS
- **Element/selector:** JS line 1435: `style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px"`
- **Current behavior:** Status, Session, BMAD Workflow, Run After — all in a 4-column grid. At 320px: each column is ~70px wide, making select dropdowns unreadable and unusable
- **Proposed fix:** Convert inline style to a CSS class:
  ```css
  .form-grid-4 { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; }
  @media (max-width: 800px) {
    .form-grid-4 { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 480px) {
    .form-grid-4 { grid-template-columns: 1fr; }
  }
  ```
  Then change JS: `<div class="form-grid-4">` instead of inline style
- **Priority:** P1 — **CRITICAL: form is unusable on mobile**

#### ISSUE 6.2 — Session config row overflows
- **Element/selector:** `.sc-row` (line 1508)
- **Current behavior:** `display:flex; align-items:center; gap:7px; flex-wrap:wrap` — contains Mode (3 btns), Agent (2 btns), Model (3 btns), Turns (input). At 320px this wraps to 3-4 rows but individual segment groups don't wrap well
- **Proposed fix:**
  ```css
  @media (max-width: 600px) {
    .sc-row { flex-direction: column; align-items: stretch; gap: 8px; }
    .sc-seg { flex-wrap: wrap; justify-content: flex-start; }
    .sc-sep { display: none; }
  }
  ```
- **Priority:** P1

#### ISSUE 6.3 — Notes & Tags / Attachments 2-column grid
- **Element/selector:** JS line 1544: `style="display:grid;grid-template-columns:1fr 1fr;gap:8px"` (bottom section)
- **Current behavior:** Notes on left, Attachments on right. At 320px: each ~140px wide — textarea nearly unusable
- **Proposed fix:** Same pattern — convert to CSS class and stack at mobile
  ```css
  .form-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  @media (max-width: 600px) {
    .form-grid-2 { grid-template-columns: 1fr; }
  }
  ```
- **Priority:** P1

#### ISSUE 6.4 — Description textarea min-height:200px
- **Element/selector:** `#fDesc` (line 1537): `style="flex:1;min-height:200px;resize:vertical"`
- **Current behavior:** 200px minimum height. On a 568px tall phone screen (320px width), after header (~52px), stats bar (~36px), form fields above (~200px), this textarea pushes below fold
- **Proposed fix:**
  ```css
  @media (max-width: 600px) {
    #fDesc { min-height: 100px !important; }
  }
  ```
  Or better: convert to CSS class with responsive override
- **Priority:** P2

#### ISSUE 6.5 — Select dropdowns text too small
- **Element/selector:** `.sel` inside form (lines 1436-1437): `style="font-size:12px"`
- **Current behavior:** Inline `font-size:12px` overrides the media query rule that sets `.sel` to 16px. iOS will auto-zoom on focus
- **Proposed fix:** Remove inline font-size or add `!important` to media query:
  ```css
  @media (max-width: 800px) {
    .sel, .inp { font-size: 16px !important; }
  }
  ```
- **Priority:** P1

#### ISSUE 6.6 — BMAD template button too small
- **Element/selector:** `#bmadTplBtn .hb` (line 1539): `style="font-size:12px;padding:4px 10px"`
- **Current behavior:** Small inline-styled button, approximately 28px tall
- **Proposed fix:** Increase touch target via CSS class
- **Priority:** P2

---

## 7. Chat Panel

### Height, Scroll, Input Area

The chat panel appears in the modal right side (`.modal-right`).

| Breakpoint | Behavior |
|---|---|
| >800px | Side-by-side with form, `flex:1` fills remaining width |
| ≤800px | Below form, `flex:1; min-height:200px` |
| ≤480px | Same as 800px, but form takes 40vh leaving ~50vh for chat |

### Issues Found

#### ISSUE 7.1 — Chat panel extremely cramped on mobile
- **Element/selector:** `.modal-right`
- **Current behavior:** At ≤800px, modal splits vertically: form gets `max-height:40vh`, chat gets `min-height:200px`. On a 568px screen (iPhone SE): 40vh = 227px for form, 200px for chat, leaving ~141px for header/footer. Chat is barely usable
- **Proposed fix:** Make chat panel expandable or use tab interface:
  ```css
  @media (max-width: 600px) {
    .modal-left { max-height: 50vh; overflow-y: auto; }
    .modal-right { min-height: 40vh; }
    /* Or: implement tab switcher between form and chat */
  }
  ```
- **Priority:** P1

#### ISSUE 7.2 — Chat reply bar input too small
- **Element/selector:** `.chat-reply-input`
- **Current behavior:** `padding: 6px 10px; font-size: 12px` — approximately 30px tall. The iOS zoom prevention rule only targets `.inp` and `.sel`, not `.chat-reply-input`
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .chat-reply-input { font-size: 16px; padding: 10px 12px; min-height: 44px; }
    .chat-reply-btn { min-height: 44px; padding: 10px 16px; font-size: 14px; }
  }
  ```
- **Priority:** P1

#### ISSUE 7.3 — Chat messages font too small
- **Element/selector:** `.modal-right .chat-panel-body` (font-size:12px), `.chat-text` (font-size:12px)
- **Current behavior:** 12px chat text is hard to read on mobile, especially in low-light conditions
- **Proposed fix:**
  ```css
  @media (max-width: 600px) {
    .modal-right .chat-panel-body { font-size: 14px; }
    .chat-text { font-size: 14px; }
    .chat-role { font-size: 11px; }
  }
  ```
- **Priority:** P2

#### ISSUE 7.4 — Chat panel header cramped
- **Element/selector:** `.chat-panel-hd`
- **Current behavior:** Contains session title, copy ID button, "Open in chat" link, and live badge — all in `font-size:12px`. On mobile, these elements wrap and overlap
- **Proposed fix:**
  ```css
  @media (max-width: 600px) {
    .chat-panel-hd { flex-wrap: wrap; gap: 4px; padding: 8px 12px; }
    .mono-tag { display: none; } /* Hide session ID on mobile */
  }
  ```
- **Priority:** P2

#### ISSUE 7.5 — Tool groups detail overflow
- **Element/selector:** `.modal-right .chat-tools-detail`
- **Current behavior:** `max-height: 200px; overflow-y: auto` — 200px is excessive on mobile where total chat area may be 200px
- **Proposed fix:**
  ```css
  @media (max-width: 600px) {
    .modal-right .chat-tools-detail { max-height: 100px; }
  }
  ```
- **Priority:** P3

---

## 8. Docs Panel

### Slide-out Behavior

| Property | Value |
|---|---|
| Position | `position: fixed; inset: 0` (100vw × 100vh) |
| Animation | `transform: translateX(100%)` when hidden |
| Layout | Header + body (sidebar 280px + content flex:1) |
| z-index | 2000 |

### Issues Found

#### ISSUE 8.1 — Docs sidebar fixed 280px doesn't adapt
- **Element/selector:** `.docs-sidebar`
- **Current behavior:** `width: 280px; flex-shrink: 0`. On 320px screen: sidebar takes 87.5% of width, leaving only 40px for document content
- **Proposed fix:**
  ```css
  @media (max-width: 768px) {
    .docs-panel-body { flex-direction: column; }
    .docs-sidebar { width: 100%; max-height: 40vh; border-right: none;
                    border-bottom: 1px solid var(--border); }
    .docs-content { flex: 1; }
  }
  ```
  Or: Use drawer pattern where sidebar is full-screen, tapping a file transitions to full-screen content view with back button
- **Priority:** P1

#### ISSUE 8.2 — Docs editor split view not responsive
- **Element/selector:** `.docs-editor` (flex row: editor-left + editor-right)
- **Current behavior:** Side-by-side editor and preview. At 320px: each half gets 160px — completely unusable for editing
- **Proposed fix:**
  ```css
  @media (max-width: 768px) {
    .docs-editor { flex-direction: column; }
    .docs-editor-left { border-right: none; border-bottom: 1px solid var(--border); }
    .docs-editor-right { max-height: 30vh; }
  }
  ```
- **Priority:** P1

#### ISSUE 8.3 — Docs panel header buttons cramped
- **Element/selector:** `.docs-panel-hd` button group
- **Current behavior:** "New Doc", "Upload", "×" buttons inline. At 320px: buttons may wrap or clip
- **Proposed fix:**
  ```css
  @media (max-width: 480px) {
    .docs-panel-hd { flex-wrap: wrap; gap: 8px; }
    .docs-panel-hd div { flex-wrap: wrap; gap: 4px; }
  }
  ```
- **Priority:** P2

#### ISSUE 8.4 — Docs file items small touch targets
- **Element/selector:** `.docs-file`
- **Current behavior:** `padding: 5px 12px 5px 24px; font-size: 12px` — approximately 32px tall
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .docs-file { padding: 10px 12px 10px 24px; min-height: 44px;
                 display: flex; align-items: center; }
    .docs-cat { padding: 10px 12px; min-height: 44px; }
  }
  ```
- **Priority:** P1

#### ISSUE 8.5 — Docs search input no mobile optimization
- **Element/selector:** `.docs-search`
- **Current behavior:** `font-size: 12px; padding: 6px 8px` — will trigger iOS zoom (below 16px)
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .docs-search { font-size: 16px; padding: 10px 12px; }
  }
  ```
- **Priority:** P1

#### ISSUE 8.6 — No swipe-to-close for docs panel
- **Element/selector:** `.docs-panel`
- **Current behavior:** Only × button to close. No swipe gesture
- **Proposed fix:** Add touch event handler for swipe-right dismiss
- **Priority:** P2

---

## 9. Chain Badges/Status Indicators

### Readability on Small Screens

### Issues Found

#### ISSUE 9.1 — Chain badge nearly illegible
- **Element/selector:** Chain badge in `makeCard()` (line 1117): `font-size:10px`
- **Current behavior:** Chain indicator shows "🔗 1/3" at 10px font with inline styles. The emoji + fraction is barely readable on mobile
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .card-foot .badge { font-size: 12px; padding: 3px 8px; }
  }
  ```
- **Priority:** P2

#### ISSUE 9.2 — Activity badges too small
- **Element/selector:** `.activity-badge`
- **Current behavior:** `font-size: 10px; padding: 1px 6px` — "⚡ 3m ago" is very small on mobile
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .activity-badge { font-size: 12px; padding: 3px 8px; }
  }
  ```
- **Priority:** P2

#### ISSUE 9.3 — Status dots too small
- **Element/selector:** `.col-dot` (8×8px), `.kb-stat-dot` (7×7px)
- **Current behavior:** Color-coded status dots are 7-8px — hard to distinguish colors on mobile
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .col-dot { width: 10px; height: 10px; }
    .kb-stat-dot { width: 9px; height: 9px; }
  }
  ```
- **Priority:** P3

#### ISSUE 9.4 — Schedule badge contains tiny clock SVG
- **Element/selector:** `.badge-sched` (line 1103): SVG 10×10px
- **Current behavior:** Clock icon at 10×10px followed by date text at 11px — hard to read
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .badge-sched { font-size: 12px; }
    .badge-sched svg { width: 12px; height: 12px; }
  }
  ```
- **Priority:** P3

#### ISSUE 9.5 — Workflow badges use inline styles
- **Element/selector:** Workflow badge in `makeCard()` (line 1106): inline `style="background:...;color:..."`
- **Current behavior:** BMAD workflow type badges ("🔍 Analysis", "📋 Planning" etc.) use inline styles with 11px font
- **Proposed fix:** Convert to CSS classes for responsive override capability
- **Priority:** P2

#### ISSUE 9.6 — Running spinner badge on cards
- **Element/selector:** `.badge-orange .spinning` (line 1097): `width:10px;height:10px`
- **Current behavior:** Tiny 10×10px spinner inside badge — barely visible on mobile
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .card-foot .spinning { width: 12px; height: 12px; }
  }
  ```
- **Priority:** P3

---

## 10. Touch Targets

### Button Sizes, Click Areas

WCAG 2.2 Level AAA requires minimum 44×44px touch targets. Level AA requires 24×24px with 24px spacing.

### Comprehensive Touch Target Audit

| Element | Selector | Current Size (approx) | Meets 44px? | Priority |
|---|---|---|---|---|
| Logo/sidebar toggle | `.logo` | 32×32px | ❌ | P1 |
| Nav buttons | `.nav-sw-btn` | 34×28px (@800px) | ❌ | P1 |
| Header buttons | `.hb` | 36×40px (@800px) | ❌ (width) | P1 |
| Project dropdown button | `.proj-dd-btn` | 120×32px | ❌ (height) | P1 |
| Refresh button | `#refreshBtn` | 36×40px | ❌ | P1 |
| Add task button | `#addBtn` | 60×40px | ❌ (height) | P1 |
| Card edit button | `.cbtn` (✎) | 22×18px | ❌ | P1 |
| Card delete button | `.cbtn` (✕) | 22×18px | ❌ | P1 |
| Column add button | `.col-add` | 240×30px | ❌ (height) | P1 |
| Modal close button | `.modal-close` | 28×24px | ❌ | P1 |
| Sidebar close button | `.kb-sidebar-hd .modal-close` | 24×24px | ❌ | P1 |
| Sidebar project items | `.kb-sidebar-proj-hd` | 280×36px | ❌ (height) | P1 |
| Sidebar session items | `.kb-sidebar-sess` | 244×28px | ❌ (height) | P1 |
| Stats bar buttons | `#sprintSyncBtn`, `#bmadDocsBtn` | 80×28px | ❌ (height) | P1 |
| Chat reply button | `.chat-reply-btn` | 60×30px | ❌ (height) | P1 |
| Docs panel file items | `.docs-file` | 256×32px | ❌ (height) | P1 |
| Docs panel category headers | `.docs-cat` | 256×28px | ❌ (height) | P2 |
| Form select dropdowns | `.sel` | full-width×36px | ❌ (height) | P2 |
| Form buttons (Mode/Agent/Model) | `.sc-btn` | 50×28px | ❌ | P1 |
| Max turns input | `.sc-turns` | 55×28px | ❌ (height) | P2 |
| Attachment remove button | `.att-chip button` | 16×16px | ❌ | P1 |
| Toast notification | `.toast` | auto-sized | N/A (not interactive) | — |
| Card (overall tap area) | `.card` | 240×60px+ | ✅ | — |
| Project dropdown items | `.proj-dd-item` | 300×40px | ❌ (height) | P2 |
| Docs editor toolbar buttons | `.docs-editor-toolbar button` | 24×24px | ❌ | P2 |

### Issues Found

#### ISSUE 10.1 — Logo/sidebar toggle too small
- **Element/selector:** `.logo`
- **Current behavior:** 32×32px — used as sidebar toggle on mobile
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .logo { width: 44px; height: 44px; border-radius: 12px; font-size: 12px; }
  }
  ```
- **Priority:** P1

#### ISSUE 10.2 — Card action buttons critically small
- **Element/selector:** `.cbtn`
- **Current behavior:** `padding: 2px 5px; font-size: 12px` — rendered ~22×18px. These appear on hover (desktop) and always-visible on mobile via `card-actions { opacity:1 }`. Users will constantly miss-tap
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .cbtn { padding: 8px 10px; font-size: 16px; min-width: 44px; min-height: 44px;
            display: flex; align-items: center; justify-content: center; }
    .card-actions { display: flex !important; gap: 4px; }
  }
  ```
- **Priority:** P1

#### ISSUE 10.3 — Attachment chip remove button critically small
- **Element/selector:** `.att-chip button`
- **Current behavior:** `padding: 0; font-size: 13px` — approximately 13×13px touch target
- **Proposed fix:**
  ```css
  @media (max-width: 800px) {
    .att-chip button { padding: 6px; min-width: 32px; min-height: 32px;
                       display: flex; align-items: center; justify-content: center; }
  }
  ```
- **Priority:** P1

#### ISSUE 10.4 — Drag and drop non-functional on touch devices
- **Element/selector:** Cards with `draggable=true`
- **Current behavior:** Uses mouse-only `dragstart`/`dragover`/`drop` events. Touch devices fire `touchstart`/`touchmove`/`touchend` which are not handled. **Drag and drop completely broken on mobile**
- **Proposed fix:** Integrate a touch-compatible drag library (SortableJS) or implement touch handlers:
  ```javascript
  // Option A: Use SortableJS library
  // Option B: Add touch event polyfill
  // Option C: Replace D&D with tap→select→tap-target pattern on mobile
  ```
- **Priority:** P1

---

## 11. Issue Summary Table

### P1 — Unusable (23 issues)

| # | Section | Issue | Selector |
|---|---|---|---|
| 1 | Header | Project dropdown hidden at ≤480px | `.hdr-meta` |
| 2 | Header | Project dropdown menu overflows 320px | `.proj-dd-menu` |
| 3 | Header | Buttons below 44px touch targets | `.hb` |
| 4 | Form | 4-column grid inline style unusable | JS line 1435 |
| 5 | Form | Session config row overflows | `.sc-row` |
| 6 | Form | Notes/Attachments 2-col grid too narrow | JS line 1544 |
| 7 | Form | Select font-size:12px triggers iOS zoom | `.sel` inline |
| 8 | Modal | Should be full-screen on mobile | `.modal` |
| 9 | Modal | Modal-left 320px too wide | `.modal-left` |
| 10 | Modal | Close button too small | `.modal-close` |
| 11 | Modal | Footer buttons cramped | `.modal-ft` |
| 12 | Modal | Confirm dialog overflows 320px | `#confirmOv .modal` |
| 13 | Sidebar | 280px fixed width too wide | `.kb-sidebar` |
| 14 | Sidebar | Close button too small | `.kb-sidebar-hd .modal-close` |
| 15 | Sidebar | Session items too small | `.kb-sidebar-sess` |
| 16 | Chat | Reply input too small / zoom trigger | `.chat-reply-input` |
| 17 | Chat | Panel cramped in stacked layout | `.modal-right` |
| 18 | Docs | Sidebar 280px doesn't adapt | `.docs-sidebar` |
| 19 | Docs | Editor split view not responsive | `.docs-editor` |
| 20 | Docs | File items too small | `.docs-file` |
| 21 | Docs | Search triggers iOS zoom | `.docs-search` |
| 22 | Touch | Card action buttons critically small | `.cbtn` |
| 23 | Touch | Drag & drop non-functional on touch | `draggable` events |

### P2 — Poor UX (16 issues)

| # | Section | Issue | Selector |
|---|---|---|---|
| 1 | Columns | No scroll position indicator | `.board` |
| 2 | Columns | Headers not sticky | `.col-head` |
| 3 | Sidebar | No backdrop overlay | `.kb-sidebar` |
| 4 | Sidebar | No swipe-to-close | `.kb-sidebar` |
| 5 | Header | Nav switcher wide for 320px | `.nav-sw` |
| 6 | Header | Multi-row wrapping | `.hdr` |
| 7 | Form | Description 200px min-height excessive | `#fDesc` |
| 8 | Form | BMAD template button small | `#bmadTplBtn` |
| 9 | Chat | Messages font too small | `.chat-text` |
| 10 | Chat | Header cramped | `.chat-panel-hd` |
| 11 | Docs | Header buttons cramped | `.docs-panel-hd` |
| 12 | Docs | No swipe-to-close | `.docs-panel` |
| 13 | Badges | Chain badge nearly illegible | Chain badge inline |
| 14 | Badges | Activity badges too small | `.activity-badge` |
| 15 | Badges | Workflow badges inline styles | Workflow badge inline |
| 16 | Touch | Attachment remove button small | `.att-chip button` |

### P3 — Nice-to-Have (8 issues)

| # | Section | Issue | Selector |
|---|---|---|---|
| 1 | Columns | Board divider wastes space | `.board-divider` |
| 2 | Columns | Archive column wide when collapsed | `.col-archive` |
| 3 | Columns | Column count badge tiny | `.col-cnt` |
| 4 | Columns | Column add button height | `.col-add` |
| 5 | Badges | Status dots too small | `.col-dot`, `.kb-stat-dot` |
| 6 | Badges | Schedule badge SVG tiny | `.badge-sched svg` |
| 7 | Badges | Running spinner tiny | `.spinning` in card |
| 8 | Chat | Tool group detail too tall | `.chat-tools-detail` |

---

## 12. Proposed Implementation Order

### Sprint 1: Critical Unblocking (P1 — estimated 2-3 days)

**Goal:** Make kanban usable on mobile phones

1. **Fix project dropdown visibility at ≤480px** (ISSUE 5.1) — unblocks all functionality
2. **Convert inline grid styles to CSS classes** (ISSUES 6.1, 6.3) — unblocks form usage
3. **Make modal full-screen on mobile** (ISSUE 3.1) — unblocks task editing
4. **Fix all font-size:16px for iOS zoom** (ISSUES 6.5, 7.2, 8.5) — prevents disorienting zoom
5. **Increase touch targets to 44px minimum** (ISSUES 10.1-10.3) — enables reliable interaction
6. **Fix project dropdown menu overflow** (ISSUE 5.2) — enables project selection
7. **Fix sidebar width on mobile** (ISSUE 4.1) — enables project browsing
8. **Fix session config overflow** (ISSUE 6.2) — enables session configuration
9. **Fix docs panel sidebar** (ISSUE 8.1) — enables document viewing
10. **Fix docs editor split** (ISSUE 8.2) — enables document editing

### Sprint 2: UX Polish (P2 — estimated 2 days)

1. Add sidebar backdrop overlay
2. Add swipe gestures for sidebar/docs panel
3. Improve chat panel layout
4. Add scroll indicators for board
5. Sticky column headers
6. Improve badge readability

### Sprint 3: Touch & Enhancement (P3 + remaining — estimated 1-2 days)

1. Implement touch-compatible drag and drop (SortableJS or custom)
2. Hide board dividers on mobile
3. Optimize animations for mobile
4. Add CSS safe area insets

### CSS Changes Required (Summary)

A new responsive section should be added to the `<style>` block with these breakpoints:

```css
/* ─── Enhanced Mobile ─── */
@media (max-width: 600px) {
  /* Full-screen modal */
  /* Stacked form grids */
  /* Docs panel column layout */
  /* Sidebar full-width */
  /* Enlarged touch targets */
}

@media (max-width: 375px) {
  /* Extra-small phone adjustments */
  /* Tighter spacing */
  /* Single-column everything */
}
```

### JavaScript Changes Required (Summary)

1. Convert inline `style="grid-template-columns:..."` to CSS classes (buildForm function)
2. Convert inline `style="font-size:12px"` on selects to CSS classes
3. Add touch event handlers or integrate SortableJS for drag & drop
4. Consider mobile detection for conditional features (drag vs tap-to-move)

---

*End of audit. This is a read-only assessment — no files were modified.*
