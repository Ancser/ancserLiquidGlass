---
name: liquid-glass
description: Build, refactor, debug, and verify Apple-style refractive Liquid Glass UI for web pages with the bundled SVG feDisplacementMap engine. Use when a task mentions liquid glass, glassmorphism, refractive lenses, distorted translucent controls, doubled edges, offset samples, release flashes, or resize-time rendering stalls.
---

# Liquid Glass

Use the bundled engine. Do not copy its implementation into a demo, component, or
new framework adapter.

## Canonical files

- `assets/glass-core.js` — the only rendering engine. It bakes displacement,
  shrink, and specular maps, creates SVG filters, samples a scoped DOM stage,
  batches rebuilds, caches maps, and exposes the public API.
- `assets/glass-core.css` — the required structural scaffold for optical layers.
  Theme and component appearance belong in the consuming page.
- The repository-root `index.html` — the reference demo and GitHub Pages entry.

Keep the skill itself concise. Do not add README, installation guide, changelog,
or duplicate engine files under the skill directory.

## Minimal integration

Add the structural CSS and one hidden SVG definition root:

```html
<link rel="stylesheet" href="glass-core.css">
<svg class="filter-root" data-glass-defs aria-hidden="true"><defs></defs></svg>

<section class="stage" data-stage="settings">
  <button class="optical-surface" data-optical="thumb" aria-hidden="true"></button>
  <span class="control-source-content">Settings</span>
</section>
<script src="glass-core.js"></script>
```

Mount once after the stage exists:

```js
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
```

`data-stage` defines the smallest scene to sample. `data-optical="name"`
defines a lens and selects `settings.name`. Add `data-container-glass` only when
the surface is a shell containing another lens; name its matching shell setting
`<lensName>Container`.

The engine observes resize by default. Use `glass.sync(name)` after a cheap
position or content update, `glass.rebuild(name)` after tuning or theme changes,
and `glass.destroy()` before remounting or removing the scene.

## Rules for implementation

1. Keep the interactive DOM as the source of truth. Generated optical layers are
   visual-only and must remain `aria-hidden="true"` and `pointer-events: none`.
2. Keep `[data-stage]` small. Every lens clones its nearest stage; a whole-page
   stage multiplies clone and filter cost.
3. Put optics in the settings table and appearance in CSS tokens. Do not add
   per-element tuning attributes or selectors keyed to IDs.
4. Keep motion values (`idleScale`, `activeScale`, `stiffness`, `damping`,
   `stretch`) out of geometry and map caches.
5. Do not rebuild maps from pointermove, scroll, or every resize callback. The
   engine synchronizes geometry each frame and bakes once after resize settles.
6. For dynamic controls, use the `onSample(surface)` mount hook to copy only the
   small state needed by the sampled clone. Do not pretend arbitrary video,
   canvas, cross-origin iframe, or third-party widget output can be cloned.
7. Provide a non-refractive fallback for unsupported SVG filters, forced colors,
   reduced motion, and low-power devices. Readability and interaction must not
   depend on the glass layer.

## Debugging checklist

- Doubled or shifted content: check the neutral 128-channel map pad and the
  measured stage/layer geometry before changing filter regions.
- Shrink stops at a shell: feed the child `shrunk` result into refraction; do not
  restore the parent composite inside the shell mask.
- Release flash: drive the material backing and optical layer from the same
  state variable, not from separate classes and transitions.
- Black labels: keep the source label available or give the visual content pass
  its own opacity clock.
- Resize stall: inspect every `ResizeObserver` and every `toDataURL` call. There
  must be one shared settle policy and no duplicate engine in the consuming page.

## Verification

Before claiming a change works:

- Run `node --check assets/glass-core.js`.
- Run the repository tests with `pytest -q`.
- Serve the repository over HTTP and verify the demo at a normal viewport and a
  narrow viewport; do not rely on a `file://` test for module or asset paths.
- Exercise a real pointer gesture, theme change, resize drag, and destroy/remount
  cycle. Resting DOM styles do not catch release flashes or stale sampled clones.
