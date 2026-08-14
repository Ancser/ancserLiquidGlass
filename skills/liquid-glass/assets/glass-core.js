/* ============================================================
   liquid-glass core — refraction surfaces via SVG feDisplacementMap

   Bake a displacement field into an image (red channel = X, green = Y),
   hand it to feDisplacementMap, and the filter bends whatever is behind
   the element. Everything else here exists to keep that one idea correct
   under motion, nesting, theming and resize.

   USAGE
       const glass = LiquidGlass.mount({
           filterDefs: document.querySelector("#glass-defs"),
           settings: { myControl: { ...tuning } },
       });
       glass.rebuild();

   Mark up the page with three attributes:
       [data-stage]              the scene a surface samples
       [data-optical="name"]     a lens; name selects its tuning entry
       [data-container-glass]    this lens is a shell others sit inside

   Read SKILL.md before changing anything in here. Several of these
   functions look like they contain redundant steps; each one is load
   bearing and the comment above it says which bug it prevents.
   ============================================================ */
(function (global) {
    "use strict";

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    /* ── state ───────────────────────────────────────────────────── */

    /* Tuning per component name. mount() merges the caller's values over
       these, so an unspecified field still has a sane value rather than
       NaN propagating into a displacement map. */
    const DEFAULT_TUNING = {
        profile: "convex-squircle",
        bezel: 18, refraction: 0.9, thickness: 70, shrink: 0.1,
        specular: 0.6, blur: 0.18, saturation: 1.22,
        idleScale: 1, activeScale: 1.4,
        stiffness: 520, damping: 34, stretch: 0.14,
    };

    const settings = {};
    const surfaces = [];
    let filterDefs = null;
    let onSample = null;
    let onRebuild = null;
    let root = null;
    let resizeObserver = null;
    let destroyed = false;
    let pendingFilterFrame = 0;
    let pendingSyncFrame = 0;
    let geometrySettleTimer = 0;
    let geometrySettleMs = 180;

    let kernelCacheHits = 0;
    let kernelCacheMisses = 0;
    const activeSpringLoops = new Set();
    const generatedFilters = new Set();

    function scopedQueryAll(selector) {
        const scope = root || document;
        const result = Array.from(scope.querySelectorAll(selector));
        if (scope.matches && scope.matches(selector)) result.unshift(scope);
        return result;
    }

    /* Every resize path goes through here.

       Two different costs need two different cadences. Syncing geometry is
       transform maths, cheap enough for every tick, and it MUST run every tick
       or the sampled clone slides out of alignment while the window moves.
       Re-baking is per-pixel work plus PNG encoding, and a resize drag emits a
       tick per frame -- baking per tick is (surfaces x frames) bakes, which
       blows a bounded cache in a few frames and then thrashes.

       This is one function rather than a debounce bolted onto each observer on
       purpose. There are two observers (stages, and the optional public one),
       and giving one of them its own policy is exactly the private-contract
       mistake that leaves the other one still freezing the page. */
    function scheduleGeometryRebuild() {
        if (destroyed) return;
        scheduleOpticalSync();
        clearTimeout(geometrySettleTimer);
        geometrySettleTimer = setTimeout(
            () => scheduleFilterRebuild(), geometrySettleMs
        );
    }

    const profiles = {
        "convex-circle": (x) => Math.sqrt(1 - (1 - x) ** 2),
        "convex-squircle": (x) => (1 - (1 - x) ** 4) ** 0.25,
        "concave": (x) => 1 - Math.sqrt(1 - (1 - x) ** 2),
        "lip": (x) => {
            const smooth = x ** 3 * (x * (x * 6 - 15) + 10);
            const convex = Math.sqrt(1 - (1 - x) ** 2);
            return (1 - smooth) * convex + smooth * (1 - convex);
        },
    };

    class Spring {
        constructor(value, stiffness = 500, damping = 32) {
            this.value = value;
            this.target = value;
            this.velocity = 0;
            this.stiffness = stiffness;
            this.damping = damping;
        }

        update(dt, config) {
            this.stiffness = config.stiffness;
            this.damping = config.damping;
            const force = (this.target - this.value) * this.stiffness;
            this.velocity += (force - this.velocity * this.damping) * dt;
            this.value += this.velocity * dt;
            return this.value;
        }

        settled(epsilon = 0.001) {
            return (
                Math.abs(this.target - this.value) < epsilon
                && Math.abs(this.velocity) < epsilon
            );
        }
    }

    function fastReturn(spring, target, retain = 0.38) {
        spring.value = target + (spring.value - target) * retain;
        spring.target = target;
        spring.velocity *= 0.18;
    }

    function cutOriginalContentUnderLens(contentLayers, lens, active) {
        if (!active) {
            contentLayers.forEach((content) => {
                content.style.clipPath = "";
                content.style.webkitClipPath = "";
            });
            return;
        }

        const lensRect = lens.getBoundingClientRect();
        contentLayers.forEach((content) => {
            const rect = content.getBoundingClientRect();
            const seam = 0.75;
            const left = lensRect.left - rect.left - seam;
            const top = lensRect.top - rect.top - seam;
            const right = lensRect.right - rect.left + seam;
            const bottom = lensRect.bottom - rect.top + seam;
            const width = Math.max(0, right - left);
            const height = Math.max(0, bottom - top);
            const radius = Math.min(width, height) / 2;
            const number = (value) => Math.round(value * 100) / 100;
            const outer = [
                "M 0 0",
                `H ${number(rect.width)}`,
                `V ${number(rect.height)}`,
                "H 0 Z",
            ].join(" ");
            const hole = [
                `M ${number(left + radius)} ${number(top)}`,
                `H ${number(right - radius)}`,
                `A ${number(radius)} ${number(radius)} 0 0 1 ${number(right)} ${number(top + radius)}`,
                `V ${number(bottom - radius)}`,
                `A ${number(radius)} ${number(radius)} 0 0 1 ${number(right - radius)} ${number(bottom)}`,
                `H ${number(left + radius)}`,
                `A ${number(radius)} ${number(radius)} 0 0 1 ${number(left)} ${number(bottom - radius)}`,
                `V ${number(top + radius)}`,
                `A ${number(radius)} ${number(radius)} 0 0 1 ${number(left + radius)} ${number(top)}`,
                "Z",
            ].join(" ");
            const clip = `path(evenodd, "${outer} ${hole}")`;
            content.style.clipPath = clip;
            content.style.webkitClipPath = clip;
        });
    }

    function physicalProfile(config, bezelWidth, sampleCount = 256) {
        const surface = profiles[config.profile] || profiles["convex-squircle"];
        const eta = 1 / 1.5;
        const values = [];
        for (let i = 0; i < sampleCount; i += 1) {
            const x = i / sampleCount;
            const y = surface(x);
            const dx = x < 1 ? 0.0001 : -0.0001;
            const derivative =
                (surface(clamp(x + dx, 0, 1)) - y) / dx;
            const magnitude = Math.hypot(derivative, 1) || 1;
            const normalX = -derivative / magnitude;
            const normalY = -1 / magnitude;
            const dot = normalY;
            const k = 1 - eta * eta * (1 - dot * dot);
            if (k < 0) {
                values.push(0);
                continue;
            }
            const root = Math.sqrt(k);
            const refractedX = -(eta * dot + root) * normalX;
            const refractedY = eta - (eta * dot + root) * normalY;
            values.push(
                Math.abs(refractedY) < 1e-6
                    ? 0
                    : refractedX
                        * ((y * bezelWidth + config.thickness) / refractedY)
            );
        }
        return values;
    }

    function capsuleCoordinate(value, size, radius) {
        const body = size - radius * 2;
        if (value < radius) return value - radius;
        if (value >= size - radius) return value - radius - body;
        return 0;
    }

    function createDisplacementMap(config, width, height, radius) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        const image = context.createImageData(width, height);
        const data = image.data;
        const safeRadius = clamp(radius, 2, Math.min(width, height) / 2 - 1);
        const bezel = clamp(config.bezel, 2, Math.max(2, safeRadius - 2));
        const profile = physicalProfile(config, bezel);
        const maximum = Math.max(1e-6, ...profile.map((v) => Math.abs(v)));
        const outerSquared = (safeRadius + 1) ** 2;
        const radiusSquared = safeRadius ** 2;
        const innerSquared = Math.max(0, safeRadius - bezel) ** 2;

        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const offset = (y * width + x) * 4;
                data[offset] = 128;
                data[offset + 1] = 128;
                data[offset + 2] = 128;
                data[offset + 3] = 255;
                const cx = capsuleCoordinate(x, width, safeRadius);
                const cy = capsuleCoordinate(y, height, safeRadius);
                const distanceSquared = cx * cx + cy * cy;
                if (distanceSquared > outerSquared || distanceSquared < innerSquared) {
                    continue;
                }
                const distance = Math.sqrt(distanceSquared);
                const alpha = distanceSquared < radiusSquared
                    ? 1
                    : 1 - (distance - safeRadius)
                        / (Math.sqrt(outerSquared) - safeRadius);
                const index = Math.floor(
                    clamp((safeRadius - distance) / bezel, 0, 1)
                    * profile.length
                );
                const displacement =
                    profile[clamp(index, 0, profile.length - 1)] || 0;
                const nx = distance > 0 ? -cx / distance : 0;
                const ny = distance > 0 ? -cy / distance : 0;
                data[offset] = Math.round(clamp(
                    128 + nx * (displacement / maximum) * 127 * alpha,
                    0,
                    255
                ));
                data[offset + 1] = Math.round(clamp(
                    128 + ny * (displacement / maximum) * 127 * alpha,
                    0,
                    255
                ));
            }
        }
        context.putImageData(image, 0, 0);
        return { url: canvas.toDataURL("image/png"), maximum, bezel };
    }

    function createShrinkMap(config, width, height, radius) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        const image = context.createImageData(width, height);
        const data = image.data;
        /* Yes -- negative shrink magnifies.

           zoomOut > 0 displaces outward from the centre, so the copy
           reads as pushed away (shrunk). Flip the sign and it
           displaces inward, which magnifies. This clamped to [0, 0.8]
           so only shrink was reachable; the range is now symmetric.

           `maximum` must be taken on the absolute value -- it is the
           normalisation divisor for the map, and with a negative
           zoomOut the old Math.max(1e-6, ...) collapsed to 1e-6 and
           the displacement channels saturated. */
        const shrink = clamp(config.shrink || 0, -0.8, 0.8);
        const zoomOut = shrink !== 0 ? 1 / (1 - shrink) - 1 : 0;
        const maximum = Math.max(
            1e-6,
            Math.abs(width * 0.5 * zoomOut),
            Math.abs(height * 0.5 * zoomOut)
        );

        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const offset = (y * width + x) * 4;
                const dx = (x - width / 2) * zoomOut;
                const dy = (y - height / 2) * zoomOut;
                data[offset] = Math.round(clamp(
                    128 + dx / maximum * 127,
                    0,
                    255
                ));
                data[offset + 1] = Math.round(clamp(
                    128 + dy / maximum * 127,
                    0,
                    255
                ));
                data[offset + 2] = 128;
                data[offset + 3] = 255;
            }
        }
        context.putImageData(image, 0, 0);
        return {
            url: canvas.toDataURL("image/png"),
            scale: shrink !== 0 ? maximum * 2 : 0,
        };
    }

    function createSpecularMap(config, width, height, radius) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        const image = context.createImageData(width, height);
        const data = image.data;
        const safeRadius = clamp(radius, 2, Math.min(width, height) / 2 - 1);
        const outerSquared = (safeRadius + 1) ** 2;
        const innerSquared = Math.max(0, safeRadius - 1.8) ** 2;
        const lightX = Math.cos(-Math.PI * 0.72);
        const lightY = Math.sin(-Math.PI * 0.72);

        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const cx = capsuleCoordinate(x, width, safeRadius);
                const cy = capsuleCoordinate(y, height, safeRadius);
                const squared = cx * cx + cy * cy;
                if (squared > outerSquared || squared < innerSquared) continue;
                const distance = Math.sqrt(squared);
                const nx = distance > 0 ? cx / distance : 0;
                const ny = distance > 0 ? -cy / distance : 0;
                const dot = Math.abs(nx * lightX + ny * lightY);
                const edge = clamp((safeRadius - distance) / 1.8, 0, 1);
                const curve = dot * Math.sqrt(1 - (1 - edge) ** 2);
                const channel = Math.round(clamp(255 * curve, 0, 255));
                const offset = (y * width + x) * 4;
                data[offset] = channel;
                data[offset + 1] = channel;
                data[offset + 2] = channel;
                data[offset + 3] = Math.round(channel * curve);
            }
        }
        context.putImageData(image, 0, 0);
        return canvas.toDataURL("image/png");
    }

    function roundedRectPath(context, x, y, width, height, radius) {
        const r = clamp(radius, 0, Math.min(width, height) / 2);
        context.beginPath();
        context.moveTo(x + r, y);
        context.lineTo(x + width - r, y);
        context.quadraticCurveTo(x + width, y, x + width, y + r);
        context.lineTo(x + width, y + height - r);
        context.quadraticCurveTo(
            x + width,
            y + height,
            x + width - r,
            y + height
        );
        context.lineTo(x + r, y + height);
        context.quadraticCurveTo(x, y + height, x, y + height - r);
        context.lineTo(x, y + r);
        context.quadraticCurveTo(x, y, x + r, y);
        context.closePath();
    }

    function createContainerMaterialMap(element, width, height, radius) {
        const materialCanvas = document.createElement("canvas");
        const maskCanvas = document.createElement("canvas");
        materialCanvas.width = maskCanvas.width = width;
        materialCanvas.height = maskCanvas.height = height;
        const context = materialCanvas.getContext("2d");
        const maskContext = maskCanvas.getContext("2d");
        const shellStyle = getComputedStyle(element);
        const inset = 1;
        roundedRectPath(
            context,
            inset,
            inset,
            width - inset * 2,
            height - inset * 2,
            Math.max(0, radius - inset)
        );
        /* The live container already owns the visible rim. The material map
           only needs a restrained one-pixel copy for nested surfaces to
           sample; painting the old 2px bright border here created a second,
           offset white thread even when shrink was zero. */
        const materialRim =
            shellStyle.getPropertyValue("--glass-material-rim").trim()
            || shellStyle.borderTopColor;
        context.lineWidth = 1;
        context.strokeStyle = materialRim;
        context.stroke();
        roundedRectPath(
            maskContext,
            inset,
            inset,
            width - inset * 2,
            height - inset * 2,
            Math.max(0, radius - inset)
        );
        maskContext.fillStyle = "#fff";
        maskContext.fill();
        return {
            material: materialCanvas.toDataURL("image/png"),
            mask: maskCanvas.toDataURL("image/png"),
        };
    }

    const NEUTRAL_PAD =
        '<feFlood flood-color="rgb(128,128,128)" flood-opacity="1" result="neutralPad"></feFlood>';

    function createOpticalFilter(id, parentPass = false) {
        const ns = "http://www.w3.org/2000/svg";
        const filter = document.createElementNS(ns, "filter");
        filter.setAttribute("id", id);
        filter.setAttribute("x", "-100%");
        filter.setAttribute("y", "-100%");
        filter.setAttribute("width", "300%");
        filter.setAttribute("height", "300%");
        filter.setAttribute("color-interpolation-filters", "sRGB");
        const parentPipeline = parentPass
            ? `
                <feGaussianBlur data-node="parent-blur" in="SourceGraphic" stdDeviation="0" result="parentBlurred"></feGaussianBlur>
                <feImage data-node="parent-shrink-image" x="0" y="0" width="100" height="60" preserveAspectRatio="none" result="parentShrinkMapRaw"></feImage>
                <feMerge result="parentShrinkMap">
                    <feMergeNode in="neutralPad"></feMergeNode>
                    <feMergeNode in="parentShrinkMapRaw"></feMergeNode>
                </feMerge>
                <feDisplacementMap data-node="parent-shrink-displacement" in="parentBlurred" in2="parentShrinkMap" scale="0" xChannelSelector="R" yChannelSelector="G" result="parentShrunk"></feDisplacementMap>
                <feImage data-node="parent-displacement-image" x="0" y="0" width="100" height="60" preserveAspectRatio="none" result="parentDisplacementMapRaw"></feImage>
                <feMerge result="parentDisplacementMap">
                    <feMergeNode in="neutralPad"></feMergeNode>
                    <feMergeNode in="parentDisplacementMapRaw"></feMergeNode>
                </feMerge>
                <feDisplacementMap data-node="parent-displacement" in="parentShrunk" in2="parentDisplacementMap" scale="0" xChannelSelector="R" yChannelSelector="G" result="parentRefracted"></feDisplacementMap>
                <feColorMatrix data-node="parent-saturation" in="parentRefracted" type="saturate" values="1" result="parentSaturated"></feColorMatrix>
                <feImage data-node="parent-specular-image" x="0" y="0" width="100" height="60" preserveAspectRatio="none" result="parentSpecularMap"></feImage>
                <feComponentTransfer in="parentSpecularMap" result="parentSpecularFaded">
                    <feFuncA data-node="parent-specular-alpha" type="linear" slope="0"></feFuncA>
                </feComponentTransfer>
                <feBlend in="parentSpecularFaded" in2="parentSaturated" mode="screen" result="parentGlass"></feBlend>
                <feImage data-node="parent-mask-image" x="0" y="0" width="100" height="60" preserveAspectRatio="none" result="parentMaskMap"></feImage>
                <feComposite in="parentGlass" in2="parentMaskMap" operator="in" result="parentGlassClipped"></feComposite>
                <feImage data-node="parent-material-image" x="0" y="0" width="100" height="60" preserveAspectRatio="none" result="parentMaterialMap"></feImage>
                <feBlend in="parentMaterialMap" in2="parentGlassClipped" mode="normal" result="parentSurface"></feBlend>
                <feBlend in="parentSurface" in2="SourceGraphic" mode="normal" result="parentComposite"></feBlend>
            `
            : "";
        const sourceInput = parentPass
            ? "parentComposite"
            : "SourceGraphic";
        /* The shrink used to stop at the container's edge.

           A `nestedShrinkResolved` step took `shrunk` only OUTSIDE the
           container's mask and swapped `parentComposite` back in
           inside it -- a branch that never passed through this
           surface's shrink. The pill lives entirely inside its
           container, so its whole area took that branch: the
           container's edges were refracted by the later displacement
           pass but never moved, while the backdrop behind them shrank.
           Two different scales in one pill.

           `shrunk` already derives from parentComposite, so it carries
           a correctly shrunk container; the resolver was discarding
           it. Feeding `shrunk` straight through shrinks backdrop and
           container by the same factor, which is what the surfaces'
           matching shrink values are supposed to mean. */
        const displacementInput = "shrunk";
        filter.innerHTML = `
            ${NEUTRAL_PAD}
            ${parentPipeline}
            <feGaussianBlur data-node="blur" in="${sourceInput}" stdDeviation="0.2" result="blurred"></feGaussianBlur>
            <feImage data-node="shrink-image" x="0" y="0" width="100" height="60" preserveAspectRatio="none" result="shrinkMapRaw"></feImage>
            <feMerge result="shrinkMap">
                <feMergeNode in="neutralPad"></feMergeNode>
                <feMergeNode in="shrinkMapRaw"></feMergeNode>
            </feMerge>
            <feDisplacementMap data-node="shrink-displacement" in="blurred" in2="shrinkMap" scale="0" xChannelSelector="R" yChannelSelector="G" result="shrunk"></feDisplacementMap>
            <feImage data-node="displacement-image" x="0" y="0" width="100" height="60" preserveAspectRatio="none" result="displacementMapRaw"></feImage>
            <!-- Blur the MAP, not the output. feDisplacementMap moves by
                 integer pixels, so neighbouring map pixels produce a
                 stair-stepped edge. Smoothing the map makes the
                 displacement vary continuously; the output image itself
                 is not blurred. Cost is negligible -- the map is much
                 smaller than the output and is baked once. -->
            <feGaussianBlur data-node="displacement-aa" in="displacementMapRaw" stdDeviation="0.5" result="displacementMapAA"></feGaussianBlur>
            <feMerge result="displacementMap">
                <feMergeNode in="neutralPad"></feMergeNode>
                <feMergeNode in="displacementMapAA"></feMergeNode>
            </feMerge>
            <feDisplacementMap data-node="displacement" in="${displacementInput}" in2="displacementMap" scale="50" xChannelSelector="R" yChannelSelector="G" result="refracted"></feDisplacementMap>
            <feColorMatrix data-node="saturation" in="refracted" type="saturate" values="1.3" result="refractedSaturated"></feColorMatrix>
            <feImage data-node="specular-image" x="0" y="0" width="100" height="60" preserveAspectRatio="none" result="specularMap"></feImage>
            <feComponentTransfer in="specularMap" result="specularFaded">
                <feFuncA data-node="specular-alpha" type="linear" slope="0.15"></feFuncA>
            </feComponentTransfer>
            <feBlend in="specularFaded" in2="refractedSaturated" mode="screen"></feBlend>
        `;
        filterDefs.appendChild(filter);
        generatedFilters.add(filter);
        const parent = parentPass
            ? {
                blur: filter.querySelector('[data-node="parent-blur"]'),
                shrinkImage: filter.querySelector(
                    '[data-node="parent-shrink-image"]'
                ),
                shrinkDisplacement: filter.querySelector(
                    '[data-node="parent-shrink-displacement"]'
                ),
                displacementImage: filter.querySelector(
                    '[data-node="parent-displacement-image"]'
                ),
                displacement: filter.querySelector(
                    '[data-node="parent-displacement"]'
                ),
                saturation: filter.querySelector(
                    '[data-node="parent-saturation"]'
                ),
                specularImage: filter.querySelector(
                    '[data-node="parent-specular-image"]'
                ),
                materialImage: filter.querySelector(
                    '[data-node="parent-material-image"]'
                ),
                maskImage: filter.querySelector(
                    '[data-node="parent-mask-image"]'
                ),
                specularAlpha: filter.querySelector(
                    '[data-node="parent-specular-alpha"]'
                ),
            }
            : null;
        return {
            filter,
            parent,
            blur: filter.querySelector('[data-node="blur"]'),
            shrinkImage: filter.querySelector('[data-node="shrink-image"]'),
            shrinkDisplacement: filter.querySelector('[data-node="shrink-displacement"]'),
            displacementImage: filter.querySelector('[data-node="displacement-image"]'),
            displacement: filter.querySelector('[data-node="displacement"]'),
            saturation: filter.querySelector('[data-node="saturation"]'),
            specularImage: filter.querySelector('[data-node="specular-image"]'),
            specularAlpha: filter.querySelector('[data-node="specular-alpha"]'),
        };
    }

    function setHref(node, value) {
        node.setAttribute("href", value);
        node.setAttributeNS("http://www.w3.org/1999/xlink", "href", value);
    }

    function sanitizeClone(root) {
        root.removeAttribute("id");
        root.setAttribute("aria-hidden", "true");
        root.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        root.querySelectorAll("button, input, select, [tabindex]").forEach((node) => {
            node.setAttribute("tabindex", "-1");
        });
    }

    function markGlassTiers() {
        scopedQueryAll("[data-optical]").forEach((element) => {
            element.dataset.glassTier =
                element.dataset.optical === "precision" ? "2" : "1";
        });
    }

    function buildOpticalSurfaces() {
        markGlassTiers();
        const stages = scopedQueryAll("[data-stage]");
        const templates = new Map();
        stages.forEach((stage) => {
            const copy = stage.cloneNode(true);
            sanitizeClone(copy);
            copy.classList.add("optical-stage-copy");
            templates.set(stage, copy);
        });

        scopedQueryAll("[data-optical]").forEach((element, index) => {
            const component = element.dataset.optical;
            const stage = element.closest("[data-stage]");
            if (!stage || !templates.has(stage)) return;
            const layer = document.createElement("span");
            const world = document.createElement("span");
            const isContainerGlass = element.hasAttribute("data-container-glass");
            const needsContentBypass =
                !isContainerGlass
                && (component === "dock" || component === "segment");
            const filterNodes = createOpticalFilter(
                `optical-filter-${index}`,
                needsContentBypass
            );
            const stageCopy = templates.get(stage).cloneNode(true);
            const parentComponent = needsContentBypass
                ? `${component}Container`
                : null;
            const parentContainerSource = needsContentBypass
                ? stage.querySelector(`[data-optical="${parentComponent}"]`)
                : null;
            let contentLayer = null;
            let contentWorld = null;
            let contentStageCopy = null;
            let contentFilterNodes = null;
            layer.className = "optical-layer";
            layer.setAttribute("aria-hidden", "true");
            layer.style.filter = `url(#optical-filter-${index})`;
            world.className = "optical-world";
            if (isContainerGlass) {
                stageCopy.classList.add("container-shell-copy");
            }
            if (needsContentBypass) {
                stageCopy.classList.add(
                    "optical-background-copy",
                    "container-shell-copy"
                );
                contentLayer = document.createElement("span");
                contentWorld = document.createElement("span");
                contentStageCopy = templates.get(stage).cloneNode(true);
                contentFilterNodes = createOpticalFilter(
                    `optical-content-filter-${index}`
                );
                contentLayer.className = "optical-layer optical-content-layer";
                contentLayer.setAttribute("aria-hidden", "true");
                contentLayer.style.filter =
                    `url(#optical-content-filter-${index})`;
                contentWorld.className = "optical-world";
                contentStageCopy.classList.add("optical-content-copy");
                contentWorld.appendChild(contentStageCopy);
                contentLayer.appendChild(contentWorld);
            }
            world.appendChild(stageCopy);
            layer.appendChild(world);
            element.prepend(layer);
            if (contentLayer) element.prepend(contentLayer);
            surfaces.push({
                component,
                element,
                stage,
                layer,
                world,
                stageCopy,
                filterNodes,
                contentLayer,
                contentWorld,
                contentStageCopy,
                contentFilterNodes,
                parentComponent,
                parentContainerSource,
                lastMap: null,
                lastSpecular: null,
            });
        });

        syncOpticalSurfaces();
        rebuildFilters();
    }

    function syncOpticalSurfaces(component = null, element = null) {
        if (destroyed) return;
        pendingSyncFrame = 0;
        surfaces.forEach((surface) => {
            if (component && surface.component !== component) return;
            if (element && surface.element !== element) return;
            if (onSample) onSample(surface);
            const elementRect = surface.element.getBoundingClientRect();
            const stageRect = surface.stage.getBoundingClientRect();
            /* Scale comes from the transform matrix, never from
               rect / offsetWidth. offsetWidth is an integer while the
               rect is fractional, so their ratio invents a scale that
               is not there -- the dock bubble read 54.656/55 =
               0.99375 and the segment indicator 93.109/93 = 1.00118
               while both sat at scale(1, 1). That phantom went into
               the world's inverse scale and slid the sampled clone
               sideways. The switch thumb escaped only because its
               width is a whole number.

               hypot of the matrix columns is the general form; it
               equals |a| and |d| while there is no rotation. */
            const matrix = new DOMMatrixReadOnly(
                getComputedStyle(surface.element).transform
            );
            const scaleX = Math.max(0.01, Math.hypot(matrix.a, matrix.b));
            const scaleY = Math.max(0.01, Math.hypot(matrix.c, matrix.d));
            const anchorRect = (world) => {
                const layer = world && world.parentElement;
                return layer ? layer.getBoundingClientRect() : elementRect;
            };
            [
                [surface.world, surface.stageCopy],
                [surface.contentWorld, surface.contentStageCopy],
            ].forEach(([world, stageCopy]) => {
                if (!world || !stageCopy) return;
                const layerRect = anchorRect(world);
                const x = (
                    layerRect.left - stageRect.left + surface.stage.scrollLeft
                ) / scaleX;
                const y = (
                    layerRect.top - stageRect.top + surface.stage.scrollTop
                ) / scaleY;
                world.style.width = `${stageRect.width}px`;
                world.style.height = `${stageRect.height}px`;
                stageCopy.style.width = `${stageRect.width}px`;
                stageCopy.style.height = `${stageRect.height}px`;
                world.style.transformOrigin = "0 0";
                world.style.transform =
                    `translate3d(${-x}px, ${-y}px, 0) scale(${1 / scaleX}, ${1 / scaleY})`;
            });
            if (
                surface.filterNodes.parent
                && surface.parentContainerSource
            ) {
                /* Same rect basis as the worlds above, relative to
                   the backdrop layer, so the container map lands on
                   the container the glyphs were sampled against. */
                const baseRect = anchorRect(surface.world);
                const parentRect =
                    surface.parentContainerSource.getBoundingClientRect();
                const parentX = (parentRect.left - baseRect.left) / scaleX;
                const parentY = (parentRect.top - baseRect.top) / scaleY;
                const parentWidth = parentRect.width / scaleX;
                const parentHeight = parentRect.height / scaleY;
                [
                    surface.filterNodes.parent.shrinkImage,
                    surface.filterNodes.parent.displacementImage,
                    surface.filterNodes.parent.specularImage,
                    surface.filterNodes.parent.maskImage,
                    surface.filterNodes.parent.materialImage,
                ].forEach((node) => {
                    node.setAttribute("x", parentX.toFixed(3));
                    node.setAttribute("y", parentY.toFixed(3));
                    node.setAttribute("width", parentWidth.toFixed(3));
                    node.setAttribute("height", parentHeight.toFixed(3));
                });
            }
        });
    }

    function scheduleOpticalSync() {
        if (destroyed) return;
        if (pendingSyncFrame) cancelAnimationFrame(pendingSyncFrame);
        pendingSyncFrame = requestAnimationFrame(() => syncOpticalSurfaces());
    }

    const opticalKernelCache = new Map();

    const containerMaterialCache = new Map();

    const MAX_KERNEL_CACHE = 64;

    const MAX_MATERIAL_CACHE = 16;

    function boundedCacheSet(cache, key, value, limit) {
        if (cache.size >= limit && !cache.has(key)) {
            cache.delete(cache.keys().next().value);
        }
        cache.set(key, value);
        return value;
    }

    function opticalKernel(config, width, height, radius) {
        const key = JSON.stringify([
            width, height, Number(radius.toFixed(3)),
            config.profile, config.bezel, config.thickness,
            config.shrink,
        ]);
        const cached = opticalKernelCache.get(key);
        if (cached) {
            kernelCacheHits += 1;
            return cached;
        }
        kernelCacheMisses += 1;
        return boundedCacheSet(opticalKernelCache, key, {
            shrink: createShrinkMap(config, width, height, radius),
            displacement: createDisplacementMap(config, width, height, radius),
            specular: createSpecularMap(config, width, height, radius),
        }, MAX_KERNEL_CACHE);
    }

    function containerMaterial(element, width, height, radius) {
        /* Both rim colours are in the key because the material map paints
           the container's own stroke, so theme/token changes must miss. */
        const shellStyle = getComputedStyle(element);
        const key = JSON.stringify([
            width, height, Number(radius.toFixed(3)),
            shellStyle.borderTopColor,
            shellStyle.getPropertyValue("--glass-material-rim").trim(),
        ]);
        const cached = containerMaterialCache.get(key);
        if (cached) return cached;
        return boundedCacheSet(
            containerMaterialCache, key,
            createContainerMaterialMap(element, width, height, radius),
            MAX_MATERIAL_CACHE
        );
    }

    /* Optical numbers are device-pixel quantities, but the same component
       can legitimately be rendered at more than one CSS size. A 60px
       gallery thumb and a 32px tuner thumb must not receive the same physical
       bezel/thickness: on the smaller surface that would make the refraction
       occupy most of the pill and pull the sampled edge out of proportion.

       Use the largest live surface of a component as its reference geometry.
       This keeps the public tuning contract simple (one settings object per
       component) while making every smaller instance proportional. Layout
       height comes from offsetHeight, so a motion transform cannot make the
       baked physical profile grow during a drag. CSS may use rem/clamp/vw;
       the engine only normalizes the measured result here. */
    function componentReferenceHeight(component) {
        let reference = 0;
        surfaces.forEach((candidate) => {
            if (candidate.component !== component || !candidate.element.isConnected) {
                return;
            }
            reference = Math.max(reference, Number(candidate.element.offsetHeight) || 0);
        });
        return Math.max(1, reference);
    }

    function physicalConfigForSurface(config, component, element) {
        const height = Math.max(1, Number(element?.offsetHeight) || 1);
        const reference = componentReferenceHeight(component);
        const scale = clamp(height / reference, 0.25, 1);
        const normalized = {
            ...config,
            bezel: Number(config.bezel) * scale,
            thickness: Number(config.thickness) * scale,
            blur: Number(config.blur) * scale,
        };
        return { config: normalized, scale };
    }

    const pendingSurfaceFilters = new Set();
    let pendingSurfaceFilterFrame = 0;

    function scheduleSurfaceFilterRebuild(surface) {
        if (destroyed) return;
        pendingSurfaceFilters.add(surface);
        if (pendingSurfaceFilterFrame) return;
        pendingSurfaceFilterFrame = requestAnimationFrame(() => {
            pendingSurfaceFilterFrame = 0;
            const targets = [...pendingSurfaceFilters];
            pendingSurfaceFilters.clear();
            targets.forEach(rebuildSurface);
            scheduleOpticalSync();
        });
    }

    function rebuildSurface(surface) {
        const baseConfig = settings[surface.component];
        if (!baseConfig || !surface.element.isConnected) return;
        const width = Math.max(2, Math.round(surface.element.offsetWidth));
        const height = Math.max(2, Math.round(surface.element.offsetHeight));
        const normalized = physicalConfigForSurface(
            baseConfig,
            surface.component,
            surface.element
        );
        const config = normalized.config;
        surface.opticalScale = normalized.scale;
        const computed = getComputedStyle(surface.element);
        const radius = clamp(
            parseFloat(computed.borderTopLeftRadius) || height / 2,
            2,
            Math.min(width, height) / 2
        );
        /* A negative shrink magnifies the sampled raster. Give only those
           surfaces an oversampled filter buffer so the enlarged interior
           keeps detail without turning every interactive thumb into a costly
           high-resolution pass. */
        const filterScale = clamp(
            Number.isFinite(Number(config.filterScale))
                ? Number(config.filterScale)
                : 1,
            1,
            2
        );
        const filterResolution = `${Math.round(width * filterScale)} ${Math.round(height * filterScale)}`;
        [surface.filterNodes?.filter, surface.contentFilterNodes?.filter]
            .forEach((filter) => filter?.setAttribute("filterRes", filterResolution));
        const kernel = opticalKernel(config, width, height, radius);
        const shrink = kernel.shrink;
        const displacement = kernel.displacement;
        const specular = kernel.specular;
        const configureNodes = (
            nodes,
            passConfig,
            passShrink,
            passDisplacement,
            passSpecular,
            passWidth,
            passHeight,
            shrinkScale,
            specularStrength
        ) => {
            if (!nodes) return;
            setHref(nodes.shrinkImage, passShrink.url);
            setHref(nodes.displacementImage, passDisplacement.url);
            setHref(nodes.specularImage, passSpecular);
            [
                nodes.shrinkImage,
                nodes.displacementImage,
                nodes.specularImage,
            ].forEach((node) => {
                node.setAttribute("width", String(passWidth));
                node.setAttribute("height", String(passHeight));
            });
            nodes.shrinkDisplacement.setAttribute(
                "scale",
                shrinkScale.toFixed(3)
            );
            nodes.displacement.setAttribute(
                "scale",
                (
                    passDisplacement.maximum
                    * passConfig.refraction
                ).toFixed(3)
            );
            nodes.blur.setAttribute(
                "stdDeviation",
                passConfig.blur.toFixed(3)
            );
            nodes.saturation.setAttribute(
                "values",
                passConfig.saturation.toFixed(3)
            );
            nodes.specularAlpha.setAttribute(
                "slope",
                specularStrength.toFixed(3)
            );
        };
        configureNodes(
            surface.filterNodes,
            config,
            shrink,
            displacement,
            specular,
            width,
            height,
            shrink.scale,
            config.specular
        );
        /* The content layer is a hand-off pass for labels that were clipped
           out of the live source. It must preserve glyph geometry exactly:
           running the full displacement/blur pass on the copied text makes
           the rasterizer move it for one frame when the lens wakes up. The
           backdrop and rim above remain fully refractive; this pass only
           keeps UI text crisp and registered with its source. */
        const contentPassConfig = {
            ...config,
            refraction: 0,
            blur: 0,
            saturation: 1,
        };
        configureNodes(
            surface.contentFilterNodes,
            contentPassConfig,
            shrink,
            displacement,
            specular,
            width,
            height,
            0,
            0
        );
        if (
            surface.filterNodes.parent
            && surface.parentContainerSource
            && surface.parentComponent
        ) {
            const parentBaseConfig = settings[surface.parentComponent];
            const parentWidth = Math.max(
                2,
                Math.round(surface.parentContainerSource.offsetWidth)
            );
            const parentHeight = Math.max(
                2,
                Math.round(surface.parentContainerSource.offsetHeight)
            );
            const parentComputed = getComputedStyle(
                surface.parentContainerSource
            );
            const parentRadius = clamp(
                parseFloat(parentComputed.borderTopLeftRadius)
                    || parentHeight / 2,
                2,
                Math.min(parentWidth, parentHeight) / 2
            );
            const parentNormalized = physicalConfigForSurface(
                parentBaseConfig,
                surface.parentComponent,
                surface.parentContainerSource
            );
            const parentConfig = parentNormalized.config;
            const parentKernel = opticalKernel(
                parentConfig, parentWidth, parentHeight, parentRadius
            );
            const parentShrink = parentKernel.shrink;
            const parentDisplacement = parentKernel.displacement;
            const parentSpecular = parentKernel.specular;
            const parentMaterial = containerMaterial(
                surface.parentContainerSource,
                parentWidth,
                parentHeight,
                parentRadius
            );
            configureNodes(
                surface.filterNodes.parent,
                parentConfig,
                parentShrink,
                parentDisplacement,
                parentSpecular,
                parentWidth,
                parentHeight,
                parentShrink.scale,
                parentConfig.specular
            );
            setHref(
                surface.filterNodes.parent.materialImage,
                parentMaterial.material
            );
            setHref(
                surface.filterNodes.parent.maskImage,
                parentMaterial.mask
            );
        }
        surface.lastMap = displacement.url;
        surface.lastSpecular = specular;
        surface.kernelSize = `${width}×${height}`;
    }

    function rebuildFilters(component = null) {
        if (destroyed) return;
        pendingFilterFrame = 0;
        surfaces.forEach((surface) => {
            if (
                !component
                || surface.component === component
                || surface.parentComponent === component
            ) {
                rebuildSurface(surface);
            }
        });
        /* A tuning UI can watch rebuilds from here (to refresh map previews,
           for instance) without the engine knowing such a UI exists. */
        if (onRebuild) onRebuild(component);
        scheduleOpticalSync();
    }

    function scheduleFilterRebuild(component = null) {
        if (destroyed) return;
        if (pendingFilterFrame) cancelAnimationFrame(pendingFilterFrame);
        pendingFilterFrame = requestAnimationFrame(() => rebuildFilters(component));
    }

    function runSpringLoop(component, springs, apply, shouldContinue = null) {
        if (destroyed) return;
        if (activeSpringLoops.has(component)) return;
        activeSpringLoops.add(component);
        let previous = performance.now();
        const frame = (now) => {
            if (destroyed) {
                activeSpringLoops.delete(component);
                return;
            }
            const dt = Math.min(0.032, Math.max(0.001, (now - previous) / 1000));
            previous = now;
            const config = settings[component];
            springs.forEach((spring) => spring.update(dt, config));
            apply();
            syncOpticalSurfaces(component);
            const moving = shouldContinue
                ? shouldContinue()
                : springs.some((spring) => !spring.settled());
            if (moving) requestAnimationFrame(frame);
            else activeSpringLoops.delete(component);
        };
        requestAnimationFrame(frame);
    }

    /* ── public surface ──────────────────────────────────────────── */

    function mount(options) {
        options = options || {};
        if (surfaces.length) {
            throw new Error(
                "LiquidGlass.mount: an instance already exists. Call destroy() before mounting again."
            );
        }
        destroyed = false;
        root = options.root || document;
        filterDefs = options.filterDefs
            || root.querySelector("[data-glass-defs] defs")
            || root.querySelector("[data-glass-defs]");
        if (filterDefs && filterDefs.tagName.toLowerCase() !== "defs") {
            filterDefs = filterDefs.querySelector("defs");
        }
        if (!filterDefs) {
            throw new Error(
                "LiquidGlass.mount: no filterDefs node. Pass one, or add "
                + "<svg data-glass-defs><defs></defs></svg> to the page."
            );
        }
        if (options.settings) {
            Object.keys(options.settings).forEach((key) => {
                settings[key] = Object.assign({}, DEFAULT_TUNING, options.settings[key]);
            });
        }
        onSample = options.onSample || null;
        onRebuild = options.onRebuild || null;
        buildOpticalSurfaces();
        if (options.observeResize !== false) observeResize(options.resize);
        rebuildFilters();
        syncOpticalSurfaces();
        return api;
    }

    /* A surface's geometry changes with layout, not just with tuning, so a
       resize has to re-bake and re-measure. Debounced through the same
       batched path as everything else. */
    function observeResize(options) {
        if (typeof ResizeObserver === "undefined") return;
        if (options && options.settleMs) geometrySettleMs = options.settleMs;
        if (resizeObserver) return resizeObserver;
        resizeObserver = new ResizeObserver(scheduleGeometryRebuild);
        const observed = new Set();
        surfaces.forEach((surface) => {
            [surface.element, surface.stage].forEach((element) => {
                if (!element || observed.has(element)) return;
                observed.add(element);
                resizeObserver.observe(element);
            });
        });
        return resizeObserver;
    }

    function destroy() {
        destroyed = true;
        clearTimeout(geometrySettleTimer);
        if (pendingFilterFrame) cancelAnimationFrame(pendingFilterFrame);
        if (pendingSyncFrame) cancelAnimationFrame(pendingSyncFrame);
        if (pendingSurfaceFilterFrame) cancelAnimationFrame(pendingSurfaceFilterFrame);
        pendingFilterFrame = 0;
        pendingSyncFrame = 0;
        pendingSurfaceFilterFrame = 0;
        pendingSurfaceFilters.clear();
        if (resizeObserver) resizeObserver.disconnect();
        resizeObserver = null;
        surfaces.forEach((surface) => {
            [surface.contentLayer, surface.layer].forEach((layer) => {
                if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
            });
        });
        generatedFilters.forEach((filter) => {
            if (filter.parentNode) filter.parentNode.removeChild(filter);
        });
        generatedFilters.clear();
        surfaces.length = 0;
        activeSpringLoops.clear();
        Object.keys(settings).forEach((key) => delete settings[key]);
        filterDefs = null;
        root = null;
        onSample = null;
        onRebuild = null;
    }

    const api = {
        settings,
        surfaces,
        mount,
        observeResize,
        destroy,
        rebuild: (component) => scheduleFilterRebuild(component || null),
        sync: (component, element) => syncOpticalSurfaces(
            component || null,
            element || null
        ),
        rebuildNow: (component) => rebuildFilters(component || null),
        Spring,
        runSpringLoop,
        fastReturn,
        cutOriginalContentUnderLens,
        cacheStats: () => ({ hits: kernelCacheHits, misses: kernelCacheMisses,
                             size: opticalKernelCache.size }),
    };

    global.LiquidGlass = api;
})(typeof window !== "undefined" ? window : this);
