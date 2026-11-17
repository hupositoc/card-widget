# Widget design

The widget shows one thing: the total card spend for the current cycle. Per-card amounts are available in the JSON (`detailText`, `cards[]`) but are deliberately left off the home screen.

## Layout

```
+--------------------------------+
|                                |
|  이번 달 카드                   |   label   Pretendard Medium 14
|  1,234,567원                    |   amount  Pretendard Bold 32
|                                |   unit    Pretendard SemiBold 20
+--------------------------------+
   radius 24, padding 20, no border, no shadow
```

KWGT structure:

```
Root
└─ Overlap group (rounded rectangle background, radius 24)
   └─ Stack group, vertical, left-aligned, padding 20
      ├─ Text: "이번 달 카드"
      └─ Stack group, horizontal, bottom-aligned
         ├─ Text: amount
         └─ Text: "원"
```

The amount and the unit are separate text items in a bottom-aligned horizontal stack, so the smaller "원" sits on the same baseline area as the number instead of floating mid-height.

Tapping anywhere on the widget runs Kustom action -> Force RSS/Text/XML update, which re-fetches the web app.

## Colors

| Element | Light | Dark |
| --- | --- | --- |
| Background | `#FFFFFF` | `#17171C` |
| Label | `#8B95A1` | `#9E9EA4` |
| Amount and unit | `#191F28` | `#FFFFFF` |

WCAG contrast ratios, computed with the WCAG 2.x relative luminance formula:

| Pair | Light | Dark |
| --- | --- | --- |
| Amount on background | 16.56:1 | 17.86:1 |
| Label on background | 3.04:1 | 6.70:1 |

The amount is well above AA (4.5:1) in both themes. The light-theme label is not: at 14px Medium it only meets the 3:1 level used for large text and UI components. That is a deliberate trade-off to keep the label visually quiet, and it is acceptable here only because the label is fixed text that never changes. If you want strict AA, use `#6B7684` for the light label, which gives 4.62:1.

## Rationale

From Toss's design principles:

- One number per screen. The widget answers one question, so it shows one value. Per-card breakdowns would make each glance slower.
- Hierarchy by size and weight, not color. The amount is larger and bolder than the label. Nothing is red or green; color is reserved and not needed here.
- A two-tone grey palette: a dark grey for the content and a lighter grey for the label. No accent color.
- Generous corner radius and no borders or shadows. The card shape is enough to separate the widget from the wallpaper.

From KRDS (Korea Design System):

- Pretendard as the typeface. KRDS uses Pretendard GOV, a variant of Pretendard, so the regular Pretendard family keeps the same proportions and Korean glyph shapes.
- Label, value and unit are clearly separated. The label says what the number is, the value is the largest element, and the unit is smaller than the value so the digits are read first.
- Sufficient contrast in both light and dark themes, with the theme chosen from the system setting rather than a fixed color scheme. See the contrast table above for where this design falls short on the light label.

## KWGT formulas

Replace `<DEPLOYMENT_ID>` and `<WIDGET_KEY>` with your own values. Do not share the preset afterwards; the key is in it.

Amount (strips the trailing "원" because the unit is a separate text item):

```
$tc(reg, wg("https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?key=<WIDGET_KEY>&v=1", json, ".totalText"), "원", "")$
```

Unit text: a plain `원`.

Background color:

```
$if(si(darkmode)=1, "#17171C", "#FFFFFF")$
```

Label color:

```
$if(si(darkmode)=1, "#9E9EA4", "#8B95A1")$
```

Amount and unit color:

```
$if(si(darkmode)=1, "#FFFFFF", "#191F28")$
```

KWGT caches `wg()` results per URL. After redeploying the web app, bump `&v=1` to `&v=2` (in the amount formula and anywhere else the URL is used) to force a fresh fetch.

## Fonts

Pretendard is released under the SIL Open Font License: https://github.com/orioncactus/pretendard

1. Download the release and take `Pretendard-Medium.otf`, `Pretendard-SemiBold.otf` and `Pretendard-Bold.otf`.
2. Copy them to `Kustom/fonts` on the phone's internal storage.
3. In KWGT, pick them from the font list of each text item.
