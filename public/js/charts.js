// Small dependency-free SVG charts for the trading dashboard: bars and lines on one y-axis, with a shared
// hover/focus tooltip. Charts size to their container and redraw when it resizes.

const NS = 'http://www.w3.org/2000/svg';
const PAD = { top: 12, right: 12, bottom: 26, left: 52 };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

// rows: [{ label, value, color? }]; values lead, labels follow. Uses textContent (labels are data).
function showTip(title, rows, x, y) {
  const t = tooltip();
  t.replaceChildren();
  const h = document.createElement('div');
  h.className = 'chart-tip-title';
  h.textContent = title;
  t.append(h);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'chart-tip-row';
    if (r.color) {
      const key = document.createElement('span');
      key.className = 'chart-tip-key';
      key.style.background = r.color;
      row.append(key);
    }
    const v = document.createElement('strong');
    v.textContent = r.value;
    const l = document.createElement('span');
    l.textContent = r.label;
    row.append(v, l);
    t.append(row);
  }
  t.hidden = false;
  const w = t.offsetWidth;
  const left = Math.min(window.innerWidth - w - 8, x + 14);
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, y - t.offsetHeight - 10)}px`;
}

const hideTip = () => { if (tip) tip.hidden = true; };

function frame(container, height, yMax, fmtY) {
  const width = Math.max(260, container.clientWidth);
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });
  const ticks = niceTicks(yMax);
  const top = ticks[ticks.length - 1] || 1;
  const plotH = height - PAD.top - PAD.bottom;
  const plotW = width - PAD.left - PAD.right;
  const y = (v) => PAD.top + plotH - (Math.max(0, v) / top) * plotH;
  for (const t of ticks) {
    svg.append(svgEl('line', { x1: PAD.left, x2: width - PAD.right, y1: y(t), y2: y(t), class: t === 0 ? 'chart-axis' : 'chart-grid' }));
    const label = svgEl('text', { x: PAD.left - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'chart-label' });
    label.textContent = fmtY(t);
    svg.append(label);
  }
  return { svg, width, plotW, plotH, y, top };
}

function xLabels(svg, labels, xAt, height, plotW) {
  const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotW / 56))));
  labels.forEach((text, i) => {
    if (i % every) return;
    const t = svgEl('text', { x: xAt(i), y: height - 8, 'text-anchor': 'middle', class: 'chart-label' });
    t.textContent = text;
    svg.append(t);
  });
}

// Bar path with 4px rounded data-end, square at the baseline.
function barPath(x, yTop, w, yBase) {
  const h = yBase - yTop;
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
}

function mount(container, draw) {
  draw();
  if (container._ro) container._ro.disconnect();
  let last = container.clientWidth;
  container._ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - last) < 2) return;
    last = container.clientWidth;
    draw();
  });
  container._ro.observe(container);
}

/**
 * Single-series bar chart.
 * opts: { data, label(d) (x axis), title(d) (tooltip), value(d), fmt(v), tipRows(d) (optional extra rows), color, height, ariaLabel }
 */
export function barChart(container, opts) {
  const { data, height = 220 } = opts;
  mount(container, () => {
    const max = Math.max(0, ...data.map(opts.value));
    const { svg, plotW, y } = frame(container, height, max, opts.fmtAxis ?? opts.fmt);
    svg.setAttribute('aria-label', opts.ariaLabel ?? '');
    const band = plotW / Math.max(1, data.length);
    const bw = Math.max(2, Math.min(48, band - 2, band * 0.72));
    const xAt = (i) => PAD.left + band * i + band / 2;
    const base = y(0);
    data.forEach((d, i) => {
      const v = opts.value(d);
      const x = xAt(i) - bw / 2;
      const bar = svgEl('path', { d: barPath(x, y(v), bw, base), class: 'chart-bar', fill: opts.color ?? 'var(--series-1)' });
      const hit = svgEl('rect', { x: PAD.left + band * i, y: PAD.top, width: band, height: base - PAD.top, class: 'chart-hit', tabindex: 0 });
      hit.setAttribute('aria-label', `${opts.title(d)}: ${opts.fmt(v)}`);
      const rows = () => opts.tipRows ? opts.tipRows(d) : [{ value: opts.fmt(v), label: opts.seriesName ?? '' }];
      const on = (e) => {
        bar.classList.add('is-hot');
        const r = hit.getBoundingClientRect();
        showTip(opts.title(d), rows(), e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top + 20);
      };
      const off = () => { bar.classList.remove('is-hot'); hideTip(); };
      hit.addEventListener('pointermove', on);
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('focus', on);
      hit.addEventListener('blur', off);
      svg.append(bar, hit);
    });
    xLabels(svg, data.map(opts.label), xAt, height, plotW);
    container.replaceChildren(svg);
  });
}

/**
 * Multi-series line chart on one y-axis, with a crosshair that snaps to the nearest x and a tooltip listing
 * every series. Gaps (null values) break the line.
 * opts: { data, label(d), title(d), series: [{ name, value(d), color }], fmt(v), reference?: { value }, height }
 */
export function lineChart(container, opts) {
  const { data, series, height = 220 } = opts;
  mount(container, () => {
    const values = data.flatMap((d) => series.map((s) => s.value(d))).filter((v) => v !== null && v !== undefined);
    const max = Math.max(opts.reference?.value ?? 0, ...values, 0);
    const { svg, width, plotW, y } = frame(container, height, max * 1.05, opts.fmtAxis ?? opts.fmt);
    svg.setAttribute('aria-label', opts.ariaLabel ?? '');
    const step = data.length > 1 ? plotW / (data.length - 1) : 0;
    const xAt = (i) => (data.length > 1 ? PAD.left + step * i : PAD.left + plotW / 2);

    if (opts.reference) {
      const ry = y(opts.reference.value);
      // Named in the legend rather than on the plot, where a label would collide with the lines.
      svg.append(svgEl('line', { x1: PAD.left, x2: width - PAD.right, y1: ry, y2: ry, class: 'chart-ref' }));
    }

    for (const s of series) {
      let d = '';
      let pen = false;
      data.forEach((row, i) => {
        const v = s.value(row);
        if (v === null || v === undefined) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${xAt(i)},${y(v)}`;
        pen = true;
      });
      svg.append(svgEl('path', { d, class: 'chart-line', stroke: s.color }));
      // Markers on isolated points so a single day with data is still visible.
      data.forEach((row, i) => {
        const v = s.value(row);
        const prev = i > 0 ? s.value(data[i - 1]) : null;
        const next = i < data.length - 1 ? s.value(data[i + 1]) : null;
        if (v !== null && v !== undefined && (prev === null || prev === undefined) && (next === null || next === undefined)) {
          svg.append(svgEl('circle', { cx: xAt(i), cy: y(v), r: 4, fill: s.color, class: 'chart-dot' }));
        }
      });
    }

    const cross = svgEl('line', { y1: PAD.top, y2: y(0), class: 'chart-cross', visibility: 'hidden' });
    const dots = series.map((s) => svgEl('circle', { r: 4.5, fill: s.color, class: 'chart-dot', visibility: 'hidden' }));
    svg.append(cross, ...dots);
    const hit = svgEl('rect', { x: PAD.left - 8, y: PAD.top, width: plotW + 16, height: y(0) - PAD.top, class: 'chart-hit', tabindex: 0 });
    svg.append(hit);
    let focusIndex = data.length - 1;
    const at = (i, cx, cy) => {
      const row = data[i];
      cross.setAttribute('x1', xAt(i));
      cross.setAttribute('x2', xAt(i));
      cross.setAttribute('visibility', 'visible');
      series.forEach((s, k) => {
        const v = s.value(row);
        const ok = v !== null && v !== undefined;
        dots[k].setAttribute('visibility', ok ? 'visible' : 'hidden');
        if (ok) { dots[k].setAttribute('cx', xAt(i)); dots[k].setAttribute('cy', y(v)); }
      });
      showTip(opts.title(row), series.map((s) => ({ value: s.value(row) === null || s.value(row) === undefined ? '–' : opts.fmt(s.value(row)), label: s.name, color: s.color })), cx, cy);
    };
    const off = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); hideTip(); };
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      focusIndex = step ? Math.max(0, Math.min(data.length - 1, Math.round((px - PAD.left) / step))) : 0;
      at(focusIndex, e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', off);
    const fromFocus = () => {
      const r = svg.getBoundingClientRect();
      at(focusIndex, r.left + xAt(focusIndex), r.top + PAD.top + 20);
    };
    hit.addEventListener('focus', fromFocus);
    hit.addEventListener('blur', off);
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      focusIndex = Math.max(0, Math.min(data.length - 1, focusIndex + (e.key === 'ArrowRight' ? 1 : -1)));
      fromFocus();
    });
    xLabels(svg, data.map(opts.label), xAt, height, plotW);
    container.replaceChildren(svg);
  });
}

/** Shows the shared tooltip on hover and keyboard focus of el. title() and rows() are called when it opens. */
export function attachTip(el, title, rows) {
  const on = (e) => {
    const r = el.getBoundingClientRect();
    showTip(title(), rows(), e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top);
  };
  el.addEventListener('pointermove', on);
  el.addEventListener('focus', on);
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('blur', hideTip);
}

export function legend(items) {
  return `<div class="chart-legend">${items.map((i) => `<span><i class="chart-legend-${i.kind ?? 'line'}" style="background:${i.color}"></i>${i.label}</span>`).join('')}</div>`;
}

// Removes any tooltip left behind when the page changes.
window.addEventListener('hashchange', hideTip);
