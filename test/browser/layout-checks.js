// Geometry checks for the WebKit layout spec (webkit-layout.spec.js): no horizontal overflow, no
// clipped text, no overlapping parts of a row, and tap targets of at least 44 x 44 px.
// Not a spec (the config's testMatch is *.spec.js). Everything runs in one synchronous
// page.evaluate, so the once-a-second redraw cannot detach nodes mid-measure.
import { expect } from '@playwright/test';

export const MIN_TARGET = 44;

// Parts of one container that must not overlap each other (visible rects, pairs where one
// contains the other skipped).
export const DEFAULT_OVERLAP = [
  { container: '.row', parts: ['.big > span:first-child', '.big > .at', '.strip .stop', '.summary .badge', '.summary .bell', '.summary .arrive', '.summary .chev'] },
  { container: '.row-foot', parts: ['button', '.chev'] },
  { container: '.step.stop', parts: ['.n', '.t'] },
  { container: '.step.end', parts: ['.n', '.t'] },
  { container: '.step.mid', parts: ['.n', '.t'] },
  { container: '.row.ride', parts: ['.big > span:first-child', '.big > .at'] },
  { container: '.ride-btns', parts: ['button'] },
  { container: '#enroute', parts: ['.en-status', 'button'] },
  { container: 'header', parts: ['#toggle', '#refresh', '#open-setup'] },
  { container: '.setup-head', parts: [':scope > *'] },
  { container: '.trip-row', parts: [':scope > *'] },
  { container: '.leg-row', parts: [':scope > *'] },
  { container: '.btns', parts: [':scope > *'] },
  { container: '.field-pair', parts: [':scope > *'] },
  { container: '.perm-row', parts: [':scope > *'] },
  { container: '.item.has-dist', parts: [':scope > *'] },
];

export async function layoutViolations(page, { overlap = DEFAULT_OVERLAP, tapTargets = true } = {}) {
  // The viewport the page was given, not innerWidth: an overflowing page on a mobile viewport
  // can widen the layout viewport and hide the overflow.
  const vw = page.viewportSize().width;
  return page.evaluate(({ vw, overlap, tapTargets, MIN }) => {
    const out = [];
    const R = n => Math.round(n * 10) / 10;
    const box = r => `[${R(r.left)},${R(r.top)},${R(r.width)},${R(r.height)}]`;

    const cls = el => [...el.classList].map(c => `.${c}`).join('');
    const tag = el => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + cls(el);
    const label = el => {
      const ctx = el.parentElement?.closest('.row, #enroute, header, .setup-head, .card, .trip-row, .leg-row');
      const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${ctx && ctx !== el ? `${tag(ctx)} > ` : ''}${tag(el)} "${text}"`;
    };

    // Hidden on purpose or not laid out: skipped by every check.
    const skip = (el, { ariaHidden = true } = {}) => {
      if (el.getClientRects().length === 0) return true; // display:none, [hidden] ancestors
      if (el.ownerSVGElement || el instanceof SVGElement) return true; // map internals use transforms
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
        if (cs.opacity === '0') return true; // #ptr
        if (ariaHidden && e.getAttribute('aria-hidden') === 'true') return true;
        // .sr-only: a clipped 1px box
        if (e.classList.contains('sr-only')) return true;
      }
      return false;
    };

    // The element's rect clipped by each ancestor that clips (overflow not visible); null if nothing shows.
    const visibleRect = el => {
      const r0 = el.getBoundingClientRect();
      let { left, top, right, bottom } = r0;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        if (cs.overflowX !== 'visible') { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
        if (cs.overflowY !== 'visible') { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
      }
      if (right <= left || bottom <= top) return null;
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    };

    // 1. Overflow
    const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (sw > vw + 0.5) out.push(`overflow: document scrollWidth ${sw} > viewport ${vw}`);
    // Only the outermost overflowing elements are listed (their children overflow with them), at most 6.
    const over = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (skip(el, { ariaHidden: false })) continue;
      const r = visibleRect(el);
      if (!r || r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 0.5) over.push({ el, msg: `overflow: ${label(el)} right edge ${R(r.right)} > ${vw}` });
      else if (r.left < -0.5) over.push({ el, msg: `overflow: ${label(el)} left edge ${R(r.left)} < 0` });
    }
    // The innermost ones name the cause (a container only grows because something inside it does).
    const inner = over.filter(o => !over.some(p => p !== o && o.el.contains(p.el)));
    for (const o of inner.slice(0, 6)) out.push(o.msg);
    if (inner.length > 6) out.push(`overflow: ... and ${inner.length - 6} more elements`);

    // 2. Clipped text. Known blind spot: input, select, textarea and option (their text scrolls
    // inside the control and a clipped value looks the same as a long one).
    const textEls = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      if (['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE'].includes(el.tagName)) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (own || el.matches('.n, .t, .at, .big > span, .strip, .ride-head, .en-status, button, label')) textEls.add(el);
    }
    for (const el of textEls) {
      if (skip(el)) continue;
      if (el.clientWidth === 0) continue; // inline boxes
      const cs = getComputedStyle(el);
      if (cs.textOverflow === 'ellipsis') continue; // clipped on purpose: .step .n, .map-title
      if (cs.overflowX === 'visible') {
        // Nothing is clipped, but content spilling past the box (into the padding) is as cramped. Measured
        // from the content itself: scrollWidth also counts absolutely positioned ::before hit areas.
        const r = el.getBoundingClientRect();
        const limit = r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth) + 1;
        let right = -Infinity;
        const range = document.createRange();
        for (const n of el.childNodes) {
          if (n.nodeType !== 3 || !n.textContent.trim()) continue;
          range.selectNodeContents(n);
          right = Math.max(right, range.getBoundingClientRect().right);
        }
        for (const d of el.querySelectorAll('*')) {
          const dcs = getComputedStyle(d);
          if (dcs.position === 'absolute' || dcs.position === 'fixed' || dcs.display === 'none' || dcs.display === 'contents' || skip(d)) continue;
          const dr = visibleRect(d);
          if (dr) right = Math.max(right, dr.right);
        }
        if (right > limit) out.push(`clipped: ${label(el)} content spills past its box: right edge ${R(right)} > ${R(limit - 1)} (no overflow:hidden)`);
      } else if (el.scrollWidth > el.clientWidth + 1) out.push(`clipped: ${label(el)} text clipped: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth} (no ellipsis)`);
      else if (/^(hidden|clip)$/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) out.push(`clipped: ${label(el)} text clipped: scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}`);
    }

    // 3. Overlap
    for (const { container, parts } of overlap) {
      for (const c of document.querySelectorAll(container)) {
        if (skip(c)) continue;
        const items = [];
        for (const sel of parts) for (const p of c.querySelectorAll(sel)) {
          if (skip(p)) continue;
          const r = visibleRect(p);
          if (r && r.width > 0 && r.height > 0) items.push({ p, sel, r });
        }
        for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j];
          if (a.p === b.p || a.p.contains(b.p) || b.p.contains(a.p)) continue;
          const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
          const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (ix > 0.5 && iy > 0.5) {
            out.push(`overlap: ${label(c)}: '${a.sel}' "${a.p.textContent.trim().slice(0, 20)}" ${box(a.r)} overlaps '${b.sel}' "${b.p.textContent.trim().slice(0, 20)}" ${box(b.r)}`);
          }
        }
      }
    }

    // 4. Tap targets
    if (tapTargets) {
      const TARGETS = 'button, select, textarea, summary, a[href], [role="button"], [tabindex]:not([tabindex="-1"]), input:not([type=hidden]), .step.stop';
      const union = (a, b) => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
      for (const el of document.body.querySelectorAll(TARGETS)) {
        if (skip(el)) continue;
        // An input or select inside a label is measured as the label (a tap on the label focuses it).
        let host = el;
        // A row's head button is the row's expand button, but a tap anywhere on the row toggles it
        // (the button's click bubbles to the row; index.html renderRow), so the row is the target.
        const rowOf = el.matches('button.row-toggle') ? el.closest('.row') : null;
        if (rowOf) host = rowOf;
        const lab = el.matches('input, select, textarea') ? el.closest('label') : null;
        if (lab) host = lab;
        if (host !== el && skip(host)) continue;
        let r = host.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        r = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        if (host !== el) r = union(r, el.getBoundingClientRect());
        // Hit areas drawn by an absolutely positioned ::before/::after (.map-tool's inset:-3px).
        for (const h of host === el ? [el] : [el, host]) {
          const hcs = getComputedStyle(h);
          for (const pseudo of ['::before', '::after']) {
            const pcs = getComputedStyle(h, pseudo);
            if (pcs.content === 'none' || pcs.content === 'normal' || pcs.position !== 'absolute') continue;
            if (hcs.position === 'static') continue; // not positioned against this box
            const hr = h.getBoundingClientRect();
            const left = hr.left + parseFloat(hcs.borderLeftWidth) + parseFloat(pcs.left);
            const top = hr.top + parseFloat(hcs.borderTopWidth) + parseFloat(pcs.top);
            const w = parseFloat(pcs.width), ht = parseFloat(pcs.height);
            if (!(w > 0 && ht > 0) || Number.isNaN(left + top)) continue;
            r = union(r, { left, top, right: left + w, bottom: top + ht });
          }
        }
        const w = r.right - r.left, h = r.bottom - r.top;
        if (w < MIN - 0.5 || h < MIN - 0.5) out.push(`tap target: ${label(el)} ${R(w)}×${R(h)} < ${MIN}×${MIN}${lab ? ' (label)' : ''}`);
      }
    }
    return out;
  }, { vw, overlap, tapTargets, MIN: MIN_TARGET });
}

// One soft expectation per state, so a test reports every state's violations (the github
// reporter keeps about 10 annotations per step: one failure per state, not per violation).
export async function expectLayout(page, label, opts) {
  const v = await layoutViolations(page, opts);
  expect.soft([...new Set(v)], label).toEqual([]);
}
