(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll(".stat b[data-count]").forEach(function (el) {
    var target = +el.dataset.count;
    if (reduce || !target) return;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / 800);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    }
    setTimeout(function () { requestAnimationFrame(step); }, 250);
  });

  var map = document.getElementById("map");
  if (!map) return;
  var svg = map.querySelector(".edges");
  var nodes = {};
  map.querySelectorAll(".node").forEach(function (el) { nodes[el.dataset.n] = el; });
  var NS = "http://www.w3.org/2000/svg";
  var drawn = false;
  var current = null; // the focused card, re-applied after each redraw

  function pos(el) {
    var x = 0, y = 0;
    while (el && el !== map) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; }
    return { x: x, y: y };
  }

  function draw() {
    if (getComputedStyle(svg).display === "none") return;
    svg.setAttribute("viewBox", "0 0 " + map.offsetWidth + " " + map.offsetHeight);
    svg.innerHTML = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z"/></marker></defs>';
    Object.keys(nodes).forEach(function (n) {
      var to = nodes[n];
      var deps = (to.dataset.deps || "").split(" ").filter(Boolean);
      deps.forEach(function (d) {
        var from = nodes[d];
        if (!from) return;
        var a = pos(from), b = pos(to);
        var x1 = a.x + from.offsetWidth, y1 = a.y + from.offsetHeight / 2;
        var x2 = b.x - 3, y2 = b.y + to.offsetHeight / 2;
        var dx = Math.max(40, (x2 - x1) * 0.5);
        var p = document.createElementNS(NS, "path");
        p.setAttribute("d", "M" + x1 + "," + y1 + " C" + (x1 + dx) + "," + y1 + " " + (x2 - dx) + "," + y2 + " " + x2 + "," + y2);
        p.setAttribute("marker-end", "url(#arrow)");
        if (from.dataset.lane !== to.dataset.lane) p.setAttribute("class", "cross");
        p.dataset.from = d;
        p.dataset.to = n;
        svg.appendChild(p);
        if (!drawn && !reduce) {
          var len = p.getTotalLength();
          var depth = +getComputedStyle(from).getPropertyValue("--d") || 0;
          p.style.strokeDasharray = len;
          p.style.strokeDashoffset = len;
          p.style.transition = "stroke-dashoffset .9s cubic-bezier(.4,0,.2,1) " + (0.45 + depth * 0.11) + "s, opacity .25s, stroke .25s";
          requestAnimationFrame(function () { requestAnimationFrame(function () { p.style.strokeDashoffset = 0; }); });
          p.addEventListener("transitionend", function done(e) {
            if (e.propertyName !== "stroke-dashoffset") return;
            p.removeEventListener("transitionend", done);
            p.style.strokeDasharray = "";
            p.style.strokeDashoffset = "";
          });
        }
      });
    });
    drawn = true;
    if (current) focus(current);
  }

  function chain(n) {
    var seen = {};
    seen[n] = true;
    function up(x) {
      (nodes[x].dataset.deps || "").split(" ").filter(Boolean).forEach(function (d) {
        if (!seen[d] && nodes[d]) { seen[d] = true; up(d); }
      });
    }
    function down(x) {
      Object.keys(nodes).forEach(function (m) {
        var deps = (nodes[m].dataset.deps || "").split(" ");
        if (deps.indexOf(x) >= 0 && !seen[m]) { seen[m] = true; down(m); }
      });
    }
    up(n);
    down(n);
    return seen;
  }

  function focus(n) {
    current = n;
    var seen = chain(n);
    map.classList.add("focus");
    Object.keys(nodes).forEach(function (m) { nodes[m].classList.toggle("hl", !!seen[m]); });
    svg.querySelectorAll("path[data-from]").forEach(function (p) {
      p.classList.toggle("hl", !!(seen[p.dataset.from] && seen[p.dataset.to]));
    });
  }

  function blur() {
    current = null;
    map.classList.remove("focus");
    map.querySelectorAll(".hl").forEach(function (el) { el.classList.remove("hl"); });
  }

  Object.keys(nodes).forEach(function (n) {
    var el = nodes[n];
    el.addEventListener("mouseenter", function () { focus(n); });
    el.addEventListener("mouseleave", blur);
    el.addEventListener("focus", function () { focus(n); });
    el.addEventListener("blur", blur);
  });

  var queued = false;
  function redraw() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; draw(); });
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redraw);
  if (window.ResizeObserver) new ResizeObserver(redraw).observe(map);
  window.addEventListener("resize", redraw);
  setTimeout(redraw, 50);
})();
