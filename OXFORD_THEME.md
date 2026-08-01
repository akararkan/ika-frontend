# IKA — Oxford Design System

The application's complete color system, rebuilt on the University of Oxford
visual identity (2026-07-30). Layout, spacing, typography (Lora / IBM Plex
Sans / Amiri) and every component's structure are unchanged — only color
moved. The system lives in [src/styles/warm/theme.css](src/styles/warm/theme.css);
this document is its specification.

---

## 1 · Core color tokens

| Token | Value | Name | Role |
|---|---|---|---|
| `--ox-blue` | `#002147` | **Oxford Blue** | The identity. Primary actions, own-message bubbles, active navigation, headings, seals, dominant chrome. |
| `--ox-blue-deep` | `#00172F` | Oxford Blue Deep | Pressed / hover state of primary surfaces. |
| `--ox-blue-mid` | `#163E66` | Oxford Mid | Emphasised accent **text** on white (9.5:1). |
| `--ox-blue-link` | `#1F4E7E` | Oxford Link | Links, interactive icons, focus rings, secondary emphasis (7.2:1 on white). |
| `--ox-blue-glow` | `#2E6094` | Oxford Glow | Focus glows, hover of link blue. |
| `--ox-steel` | `#7FA8CE` | Steel | Muted accents, rings on dark surfaces. |
| `--ox-sky` | `#B9D6F2` | **Oxford Sky Blue** | The secondary. Selected fills, on-dark accents (everywhere gold used to sit on navy). |
| `--ox-sky-bright` | `#D6E7F8` | Sky Bright | Brightest on-dark accent text. |
| `--ox-sky-wash` | `#DCE9F6` | Sky Wash | Accent washes, selected-state fills on light. |
| `--ox-wash` | `#E7EFF8` | Quiet Wash | Hover fills, quiet selected rows. |
| `--ox-white` | `#FFFFFF` | **Oxford White** | The body background and card surface. |
| `--ox-off-white` | `#F2F0F0` | **Oxford Off-White** | Secondary surfaces (rails, wells, insets) and text on Oxford Blue. |
| `--ox-stone` | `#D9D8D6` | **Oxford Stone** | Borders, dividers, subtle chrome. Never used for text. |
| `--ox-stone-soft` | `#E9E8E6` | Stone Soft | Hairlines. |
| `--ox-stone-strong` | `#C2C1BF` | Stone Strong | Pronounced borders, strong dividers. |
| `--ox-green` | `#426A5A` | **Oxford Green** | Success states **only** (6.0:1 on white). |
| `--ox-green-wash` | `#E4EDE9` | Green Wash | Success fills. |
| `--ox-amber` | `#8A5A17` | Amber | Warnings (5.6:1 on white). |
| `--ox-amber-wash` | `#F5EAD7` | Amber Wash | Warning fills. |
| `--ox-red` | `#9C3A33` | Muted Red | Errors, destructive actions (6.3:1 on white). |
| `--ox-red-wash` | `#F6E4E2` | Red Wash | Error fills. |

Text neutrals stay **cool slate**, never stone: `--ink #1C2330` (body text),
`--ink-soft #4D5768` (secondary), `--muted #616B7C` (meta — 4.5:1 on
off-white, 5.2:1 on white, so it is AA on both sanctioned backgrounds).
Stone is for lines; slate is for words — mixing them is what makes a grey
UI look muddy.

## 2 · Semantic variables (legacy aliases)

Every pre-existing rule reads the old token names; they are re-pointed, not
removed. **New code should prefer `--ox-*`.**

```css
--rubric / --navy / --emerald  → var(--ox-blue)
--navy-deep / --emerald-deep   → var(--ox-blue-deep)
--blue / --gold / --brass      → var(--ox-blue-link)   /* old gold accents are blue now */
--gold-deep                    → var(--ox-blue-mid)
--brass-soft                   → var(--ox-sky)
--gold-wash / --brass-tint     → var(--ox-sky-wash)
--wash / --blue-wash           → var(--ox-wash)
--paper                        → var(--ox-white)        /* the body is WHITE */
--paper-2                      → #F7F6F5               /* rail half-step */
--card                         → var(--ox-white)
--card-2                       → var(--ox-off-white)
--line / --line-soft           → stone / stone-soft
--good / --good-wash           → Oxford Green family
--warn / --warn-wash           → amber family (new)
--danger                       → var(--ox-red)
--like                         → #B3453E               /* hearts keep their red */
```

### ⚠️ The `--gold` trap

`--gold` **is a dark blue.** The alias survived the migration; its value did
not. Any rule written before 2026-07-30 in the shape

```css
background: var(--gold);   color: var(--navy);      /* was gold + navy ink */
```

silently became **dark ink on a dark blue plate** (1.87:1) the day the token
was re-pointed — nothing in the rule changed, so nothing flagged it. Three
shipped that way and are now fixed (`.lv-sup-rank.r1`, `.lv-ovl-go`,
`.cn-mine-dot`).

Put **white** on a dark plate. Never pair two tokens from the `--navy` /
`--gold` / `--rubric` / `--emerald` families as background and ink: since the
migration they all resolve to dark blues.

A static checker for this lives in the scratchpad
(`audit-pairs.mjs`): it resolves the custom-property graph and reports every
rule whose own `background` + `color` fall below 4.5:1.

## 3 · Light palette (default)

- **Body:** `#FFFFFF`. **Cards/surfaces:** `#FFFFFF` with `#D9D8D6` borders
  and the soft slate shadows (`--shadow-sm/--shadow/--shadow-lg`).
- **Secondary surfaces** (sidebar, inbox rail, wells, code/quote blocks):
  `#F2F0F0`, rails may use the `#F7F6F5` half-step.
- **Dark-by-design surfaces** (reels, story viewer/editor, auth split-pane
  left, media lightbox): the Oxford blue-black ramp `#080E16 → #0A111A →
  #0B131D → #0D1520 → #0F1926 → #101A28 → #16222F → #1A2836 → #2B3B4E`,
  with `#FFFFFF`/`#F2F0F0` text and `#B9D6F2` accents. Never warm blacks,
  never neutral grey-blacks.

## 4 · Dark palette (Oxford-inspired, opt-in)

Declared as `:root[data-theme="dark"]` in theme.css. Surfaces are Oxford
night blues; Sky carries the identity; stone flips to hairline blues:

| Role | Value |
|---|---|
| Body | `#0A121C` |
| Rail | `#0E1826` |
| Card | `#101C2C` · inset `#162436` |
| Border | `#22344A` · hairline `#1A2A3D` |
| Text | `#E8EDF3` · secondary `#A9B8C8` · meta `#7F92A6` |
| Headings / identity | `#B9D6F2` (Sky) |
| Links / interactive | `#8FB8E0` (7:1 on body) |
| Selected wash | `#152A42` |
| Success | `#7FBFA5` · wash `#12291F` |
| Warning | `#D9A75A` · wash `#2C2210` |
| Error | `#D98078` |

> **Status:** the token contract is complete and shipped, but the warm/*
> area files still hard-code light-surface literals in places, so flipping
> `data-theme` today would produce a mixed result. Full dark mode = migrate
> those literals to tokens first (mechanical; the sweep script in the
> session scratchpad is the template).

## 5 · Component color mappings

| Component | Mapping |
|---|---|
| **Top bar** | White at 92% + blur; brand wordmark accent `--ox-blue-link`; search field `#F2F0F0` → white on focus with `--ox-blue-link` border. |
| **Sidebar** | `#F7F6F5`; active item `#E1EBF6` fill + Oxford Blue text/icon; badges Oxford Link on white text. |
| **Header / page titles** | Oxford Blue headings, `em` accents `--ox-blue-link`. |
| **Footer / bottom nav** | White at 96%; active Oxford Blue. |
| **Buttons — primary** | Oxford Blue bg, white text; hover `#00172F`; shadow `rgba(0,33,71,.55)` glow. |
| **Buttons — secondary/outlined** | White bg, stone border, ink text; hover: `--ox-blue-link` border + Oxford Blue text. |
| **Buttons — text/ghost** | `--ox-blue-link` label; hover `--ox-wash` fill. |
| **Forms/inputs** | White field, stone border; focus `--ox-blue-link` border + `rgba(31,78,126,.12)` ring; placeholder `#98A1B0`. |
| **Cards** | White, stone hairline, `--r` radius; hover lifts with slate shadow. |
| **Tables** | Header `#F2F0F0`, stone row dividers, hover `--ox-wash`. |
| **Dialogs/modals** | White on `rgba(11,18,32,.55)` overlay; heading Oxford Blue. |
| **Tabs** | Active: Oxford Blue text + `--ox-blue-link` underline (pill tabs: Oxford Blue fill, off-white text). |
| **Breadcrumbs** | `--muted` links → `--ox-blue-link` hover; current crumb ink. |
| **Dropdowns/menus** | White card, stone border, hover `--ox-wash`, destructive rows `--ox-red`. |
| **Checkboxes/radios** | Stone-strong border; checked Oxford Blue fill, white glyph. |
| **Switches** | Off: stone-strong track; on: Oxford Blue track, white knob. |
| **Progress bars** | Track `#E9E8E6`; fill Oxford Blue (on dark: Sky). |
| **Tooltips** | `--ink` bg, `#F2F0F0` text. |
| **Toasts/notifications** | Ink bg + off-white text; success/warn/error use their wash + deep pairs. |
| **Charts** | Series order: Oxford Blue, Steel `#7FA8CE`, Sky, plus the muted categoricals (`#8A4A5B`, `#6B5B8A`, `#2F6B72`, `#5B7A67`, `#4E6580`). Grid lines stone-soft. |
| **Icons** | Inherit text color; accent icons `--ox-blue-link`; on dark `#B9D6F2`. |
| **Links** | `--ox-blue-link`, hover Oxford Blue; on dark `#8FB8E0`. |
| **Pagination** | Current page Oxford Blue fill/white text; others ink on white with stone borders. |
| **Loading/skeletons** | `#F2F0F0` base with `#E9E8E6` shimmer. |
| **Empty states** | `--muted` prose, `--ox-blue-link` action. |
| **Verify seals** | Standard `--ox-blue-link`; scholar `--ox-blue` (darker = more senior). |
| **Chat** | Own bubbles Oxford Blue with `#F2F0F0` text and Sky accents (quotes, rate chip, waveform played-layer); others' bubbles white/stone; comments pill white with sky hover; unread markers Sky family. |

## 6 · State colors

| State | Light |
|---|---|
| Hover (rows/controls) | `#EDF3FA` fill, or border → `--ox-blue-link` |
| Active/selected | `#E1EBF6` fill + Oxford Blue text (rows), Oxford Blue fill + off-white text (pills/primary) |
| Pressed | `--ox-blue-deep` (on primary), `scale(.98)` elsewhere |
| Focus | `2px solid var(--ox-blue-link)` outline, offset 2px; inputs add the 12% ring |
| Disabled | 50% opacity, no hover response — never a color swap |
| Success | `--ox-green` on `--ox-green-wash` |
| Warning | `--ox-amber` on `--ox-amber-wash` |
| Error | `--ox-red` on `--ox-red-wash` |

## 7 · Accessibility (WCAG AA, verified)

Every token pair used for text meets AA; the load-bearing ones:
ink/white 15.8:1 · white/Oxford Blue 15.9:1 · off-white/Oxford Blue 14.1:1 ·
link/white 7.2:1 · mid/white 9.5:1 · muted/white 5.2:1 · muted/off-white
4.5:1 · green/white 6.0:1 · amber/white 5.6:1 · red/white 6.3:1 ·
Sky/Oxford Blue 10.1:1.
Placeholders (`#98A1B0`, 3.1:1) are decorative and exempt but never carry
required information.

## 8 · Consistency recommendations

1. **Never introduce a raw hex in a component.** Read a token; if no token
   fits, the palette is missing a role — add it to theme.css first.
2. **Backgrounds are white or off-white, full stop.** Tinted fills
   (`--ox-wash`, `--ox-sky-wash`) mark *state*, not surface.
3. **Stone for lines, slate for words.** Border colors and text greys come
   from different families by design.
4. **Green means success only.** Presence dots are the one sanctioned
   exception (`#3D9A5F`), and they are dots, not text.
5. **One accent per element.** Oxford Blue dominant, Sky secondary; if an
   element needs both plus green, it is over-designed.
6. **Dark surfaces are blue-black.** Any new immersive surface starts from
   the ramp in §3, takes off-white text and Sky accents.
7. **The legacy names (`--gold`, `--brass`…) are frozen.** Don't add new
   uses; migrate to `--ox-*` opportunistically when touching a rule.
8. **User content colors are sacred.** The rich-text highlight palette and
   file-type brand colors are not UI chrome — leave them.
