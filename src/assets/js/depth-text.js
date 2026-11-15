(function () {
	'use strict';

	function ensureStyles() {
		if (document.getElementById('depth-text-styles')) return;
		const style = document.createElement('style');
		style.id = 'depth-text-styles';
		style.textContent = `
.depth-text {
  display: inline-block;
  perspective: var(--depth-text-perspective);
  perspective-origin: 50% 48%;
  isolation: isolate;
}
.depth-text__stage {
  position: relative;
  display: inline-grid;
  place-items: center;
  transform-style: preserve-3d;
  transform: rotateX(-2.4deg) rotateY(3.15deg);
  transform-origin: 50% 50%;
  will-change: transform;
}
.depth-text__layer,
.depth-text__face {
  grid-area: 1 / 1;
  display: inline-block;
  font-size: var(--depth-text-font-size);
  font-weight: var(--depth-text-font-weight);
  font-family: var(--depth-text-font-family, inherit);
  line-height: 0.86;
  letter-spacing: -0.03em;
  white-space: nowrap;
  user-select: none;
  transform-style: preserve-3d;
  backface-visibility: hidden;
}
.depth-text__layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  filter: saturate(0.95) brightness(0.92);
  pointer-events: none;
}
.depth-text__face {
  position: relative;
  z-index: 1;
  color: var(--depth-text-face-color);
  text-shadow: var(--depth-text-shadow);
  transform: translateZ(0.6px);
}
@media (hover: hover) and (pointer: fine) {
  .depth-text { cursor: default; }
}
`;
		document.head.appendChild(style);
	}

	function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }

	function getLayerColor(faceColor, depthColor, index, total) {
		const progress = total <= 1 ? 1 : index / total;
		const eased = progress * progress;
		const faceMix = Math.round((1 - eased) * 72 + 4);
		return `color-mix(in srgb, ${faceColor} ${faceMix}%, ${depthColor})`;
	}

	function createDepthText(container, opts) {
		ensureStyles();
		opts = opts || {};
		const text = opts.text ?? 'Elevate';
		const layers = clamp(Math.round(opts.layers ?? 34), 2, 64);
		const depth = clamp(opts.depth ?? 2.4, 0, 12);
		const faceColor = opts.faceColor ?? '#f8fafc';
		const depthColor = opts.depthColor ?? '#7c3aed';
		const tilt = clamp(opts.tilt ?? 7.5, 0, 12);
		const pointerTracking = opts.pointerTracking ?? true;
		const smoothing = clamp(opts.smoothing ?? 0.14, 0.02, 0.35);
		const perspective = clamp(opts.perspective ?? 900, 300, 2000);
		const autoOrbit = opts.autoOrbit ?? true;
		const orbitSpeed = clamp(opts.orbitSpeed ?? 0.35, 0, 2);
		const fontSize = opts.fontSize ?? 'clamp(3rem, 12vw, 7rem)';
		const fontWeight = opts.fontWeight ?? 900;
		const fontFamily = opts.fontFamily ?? 'inherit';
		const shadow = opts.shadow ?? true;

		const root = document.createElement('span');
		root.className = 'depth-text';
		root.style.setProperty('--depth-text-perspective', `${perspective}px`);
		root.style.setProperty('--depth-text-font-size', fontSize);
		root.style.setProperty('--depth-text-font-weight', String(fontWeight));
		root.style.setProperty('--depth-text-font-family', fontFamily);
		root.style.setProperty('--depth-text-face-color', faceColor);
		root.style.setProperty('--depth-text-shadow', shadow
			? `0 22px 34px color-mix(in srgb, ${depthColor} 36%, transparent), 0 4px 8px rgba(0,0,0,0.28)`
			: 'none');

		const stage = document.createElement('span');
		stage.className = 'depth-text__stage';

		for (let layerIndex = 0; layerIndex < layers; layerIndex++) {
			const index = layers - layerIndex;
			const layer = document.createElement('span');
			layer.className = 'depth-text__layer';
			layer.setAttribute('aria-hidden', 'true');
			layer.textContent = text;
			layer.style.color = getLayerColor(faceColor, depthColor, index, layers);
			layer.style.transform = `translateZ(${-index * depth}px)`;
			stage.appendChild(layer);
		}
		const face = document.createElement('span');
		face.className = 'depth-text__face';
		face.textContent = text;
		stage.appendChild(face);

		root.appendChild(stage);
		container.appendChild(root);

		const baseRotation = { x: -tilt * 0.32, y: tilt * 0.42 };
		const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
		const canTrackPointer = pointerTracking && finePointer && !reducedMotion;

		if (reducedMotion) {
			stage.style.transform = `rotateX(${baseRotation.x}deg) rotateY(${baseRotation.y}deg)`;
			return { destroy() { root.remove(); } };
		}

		let activePointer = false;
		const startTime = performance.now();
		const current = { x: baseRotation.x, y: baseRotation.y };
		const target = { x: baseRotation.x, y: baseRotation.y };

		function applyTransform() {
			stage.style.transform = `rotateX(${current.x.toFixed(3)}deg) rotateY(${current.y.toFixed(3)}deg)`;
		}
		function handlePointerMove(e) {
			const rect = root.getBoundingClientRect();
			if (!rect.width || !rect.height) return;
			activePointer = true;
			const x = clamp((e.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.8), -1, 1);
			const y = clamp((e.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.8), -1, 1);
			target.x = baseRotation.x - y * tilt;
			target.y = baseRotation.y + x * tilt;
		}
		function handlePointerLeave() {
			activePointer = false;
			target.x = baseRotation.x;
			target.y = baseRotation.y;
		}
		if (canTrackPointer) {
			window.addEventListener('pointermove', handlePointerMove);
			window.addEventListener('pointerleave', handlePointerLeave);
			window.addEventListener('blur', handlePointerLeave);
		}

		let frameId = 0;
		function tick(now) {
			if ((!canTrackPointer || !activePointer) && autoOrbit) {
				const elapsed = (now - startTime) / 1000;
				const orbit = elapsed * orbitSpeed * Math.PI * 2;
				const fallbackAmount = canTrackPointer ? 0.18 : 0.55;
				target.x = baseRotation.x + Math.sin(orbit) * tilt * fallbackAmount;
				target.y = baseRotation.y + Math.cos(orbit * 0.85) * tilt * fallbackAmount;
			}
			current.x += (target.x - current.x) * smoothing;
			current.y += (target.y - current.y) * smoothing;
			applyTransform();
			frameId = requestAnimationFrame(tick);
		}
		applyTransform();
		frameId = requestAnimationFrame(tick);

		return {
			destroy() {
				if (canTrackPointer) {
					window.removeEventListener('pointermove', handlePointerMove);
					window.removeEventListener('pointerleave', handlePointerLeave);
					window.removeEventListener('blur', handlePointerLeave);
				}
				cancelAnimationFrame(frameId);
				root.remove();
			},
		};
	}

	window.DepthText = { create: createDepthText };
})();
