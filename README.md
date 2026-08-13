# Liquid Optics Core

一個以 SVG `feDisplacementMap` 實作的可調參數 Liquid Glass 元件引擎與 skill。
網站gallery 與左側tuner方便快速調試效果；
推薦使用coding agent輔助快速移植Liquid Glass到你目前的網站，
Apple開發者手冊建議只在必要元件使用Liquid Glass。

## Demo

**Live demo:** [Open the interactive demo](https://ancser.github.io/ancserLiquidGlass/)

`index.html` 是單頁互動 demo，左側 tuner 可以即時調整：

- `01–09` 九個公開元件：Precision Lens、Fluid Slider、Tactile Switch、Drag Dock、Segment Control、Fluid Input、Squish Volume、Layered FAB、Magnetic Stepper。
- 光學參數：bezel、refraction、thickness、shrink、specular、blur、saturation。
- 動態參數：idle scale、active scale、stiffness、damping、stretch。
- `Save / Copy / Load / Share` 與 Current settings 預覽，方便把目前調好的數值帶到自己的元件。
- `Share` 會把目前元件與調參差異放進網址 hash；別人打開分享連結就會載入同一組設定，不需要 server。

## Usage

只需要引擎 CSS、隱藏的 SVG `defs`，以及一個小型 `data-stage`：

```html
<link rel="stylesheet" href="skills/liquid-glass/assets/glass-core.css">
<svg class="filter-root" data-glass-defs aria-hidden="true"><defs></defs></svg>

<section class="stage" data-stage="settings">
  <span class="control-source-content">Settings</span>
  <span class="optical-surface" data-optical="thumb" aria-hidden="true"></span>
</section>

<script src="skills/liquid-glass/assets/glass-core.js"></script>
<script>
  const glass = LiquidGlass.mount({
    root: document,
    filterDefs: document.querySelector("[data-glass-defs] defs"),
    settings: {
      thumb: {
        bezel: 12,
        thickness: 42,
        refraction: 0.8,
        shrink: 0.08,
      },
    },
  });
</script>
```

`data-stage` 是引擎取樣的最小場景；`data-optical="thumb"` 會使用
`settings.thumb`。容器型玻璃才加上 `data-container-glass`，並提供對應的
`thumbContainer` 設定。

## Example

一個可重用的元件仍然是普通 HTML：

```html
<div class="settings-card" data-stage="settings">
  <span class="control-source-content">Settings</span>
  <span class="optical-surface" data-optical="thumb"></span>
</div>
```

外觀放在 CSS，光學數值放在 `settings`；調整參數後呼叫
`glass.rebuild("thumb")`，只移動位置或更新少量內容時呼叫
`glass.sync("thumb")`。元件卸載前呼叫 `glass.destroy()`。

## About

- **One engine**：Demo 只載入一份 `glass-core.js`，沒有第二套內嵌實作。
- **Small stages**：每個 lens 只 clone 最近的 `[data-stage]`，避免整頁取樣。
- **Cheap motion**：pointer move 只同步 geometry，不在每一幀重建 displacement map。
- **Readable fallback**：原始 HTML 仍是互動與文字來源，折射層只是視覺層。

正式檔案：

- [`index.html`](index.html) — GitHub Pages 個人網站與可調參數 Demo。
- [`skills/liquid-glass/SKILL.md`](skills/liquid-glass/SKILL.md) — 唯一正式 skill。
- [`skills/liquid-glass/assets/glass-core.js`](skills/liquid-glass/assets/glass-core.js) — 唯一引擎程式碼。
- [`skills/liquid-glass/assets/glass-core.css`](skills/liquid-glass/assets/glass-core.css) — 引擎結構 CSS。


