# Liquid Glass

一個以 SVG `feDisplacementMap` 實作的 Liquid Glass 參考元件與 Codex skill。

## 發佈內容

- [`index.html`](index.html) — GitHub Pages 個人網站與互動 Demo。
- [`skills/liquid-glass/SKILL.md`](skills/liquid-glass/SKILL.md) — 唯一正式 skill。
- [`skills/liquid-glass/assets/glass-core.js`](skills/liquid-glass/assets/glass-core.js) — 唯一引擎程式碼。
- [`skills/liquid-glass/assets/glass-core.css`](skills/liquid-glass/assets/glass-core.css) — 引擎所需的結構 CSS。

Demo 只載入這一份 engine，不在 HTML 內嵌第二份實作。

## GitHub Pages

在 GitHub repository 的 **Settings → Pages** 選擇 **Deploy from a branch**，
branch 選 `main`、folder 選 `/ (root)`。根目錄的 `index.html` 會直接成為網站入口。

## 本機預覽

```bash
python -m http.server 8000
```

然後開啟 <http://localhost:8000/>。

## 引擎最小用法

```html
<link rel="stylesheet" href="skills/liquid-glass/assets/glass-core.css">
<svg data-glass-defs aria-hidden="true"><defs></defs></svg>

<section data-stage="demo">
  <span class="optical-surface" data-optical="pill" aria-hidden="true"></span>
</section>

<script src="skills/liquid-glass/assets/glass-core.js"></script>
<script>
  const glass = LiquidGlass.mount({
    root: document,
    filterDefs: document.querySelector("[data-glass-defs] defs"),
    settings: { pill: { bezel: 14, thickness: 48, refraction: 0.8 } },
  });
</script>
```

Resize 會自動觀察；調整參數後呼叫 `glass.rebuild("pill")`，只移動或同步內容時呼叫
`glass.sync("pill")`。元件卸載前呼叫 `glass.destroy()`。

## 驗證

```bash
node --check skills/liquid-glass/assets/glass-core.js
pytest -q
```
