
(() => {
  const canvas = document.getElementById('auth-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let dots = [], raf = 0, w = 0, h = 0, dpr = 1;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = Array.from({ length: Math.min(75, Math.max(30, Math.floor(w / 22))) }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: 0.7 + Math.random() * 2.1, speed: 0.12 + Math.random() * 0.22,
      drift: Math.random() * Math.PI * 2, alpha: .16 + Math.random() * .32
    }));
  }
  function render() {
    ctx.clearRect(0, 0, w, h);
    const gradient = ctx.createRadialGradient(w * .22, h * .4, 10, w * .28, h * .45, Math.max(w, h) * .8);
    gradient.addColorStop(0, 'rgba(45,104,219,.065)');
    gradient.addColorStop(1, 'rgba(9,45,108,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    dots.forEach(d => {
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(46,118,237,${d.alpha})`; ctx.fill();
      if (!reduce.matches) {
        d.y -= d.speed;
        d.x += Math.sin(d.drift += .002) * .18;
        if (d.y < -5) { d.y = h + 5; d.x = Math.random() * w; }
      }
    });
    if (!reduce.matches && !document.hidden) raf = requestAnimationFrame(render);
  }
  const rebuild = () => { cancelAnimationFrame(raf); resize(); render(); };
  addEventListener('resize', rebuild, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rebuild(); else cancelAnimationFrame(raf); });
  reduce.addEventListener?.('change', rebuild);
  rebuild();
})();