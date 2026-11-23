/* Pet Care Hire salary calculator widget
   Draft only — not published. No external JS dependencies.
   Expects window.PCH_OEWS_DATA or a JSON script#pch-oews-data, and a
   mount node #pch-salary-tool. Optional data-src on the mount node
   fetches JSON (for the live-site loader). If the mount node has
   data-src-integrity="sha384-...", the fetched JSON is hashed with
   SHA-384 and discarded unless the digest matches. */
(function () {
  "use strict";

  var JOBS_BASE = "https://petcarehire.com/jobs";
  var NEWSLETTER = "https://petcarehire.beehiiv.com/subscribe";
  var SOURCE_URL = "https://www.bls.gov/oes/";

  var FIELD = {
    emp: 2,
    hMean: 3,
    aMean: 4,
    h10: 5,
    h25: 6,
    hMed: 7,
    h75: 8,
    h90: 9,
    a10: 10,
    a25: 11,
    aMed: 12,
    a75: 13,
    a90: 14
  };

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") n.className = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k === "on") { /* skip */ }
        else if (attrs[k] === false || attrs[k] == null) return;
        else n.setAttribute(k, attrs[k] === true ? "" : String(attrs[k]));
      });
    }
    (kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function fmtMoney(value, hourly) {
    if (value == null || value === "") return "n/a";
    if (hourly) {
      return "$" + Number(value).toFixed(2);
    }
    return "$" + Math.round(Number(value)).toLocaleString("en-US");
  }

  function fmtEmp(n) {
    if (n == null || n === "") return "n/a";
    return Number(n).toLocaleString("en-US");
  }

  function pctDiff(local, national) {
    if (local == null || national == null || national === 0) return null;
    return ((local - national) / national) * 100;
  }

  function trackingParams(occ, area, empty) {
    var place = "us";
    if (area && area.place_slug) {
      place = area.place_slug.replace(/-united-states$/, "");
    } else if (area && area.name && area.type === "state") {
      place = area.name.toLowerCase().replace(/\s+/g, "-");
    }
    var content = ((occ && occ.code) || "job") + "-" + place + (empty ? "-empty" : "");
    return [
      "utm_source=petcarehire",
      "utm_medium=salary_tool",
      "utm_campaign=salary_calculator",
      "utm_content=" + encodeURIComponent(content),
      "ref=salary-tool"
    ];
  }

  function jobCount(data, occ, stateArea) {
    var jc = data.job_counts;
    if (!jc || !jc.counts || !occ || !stateArea || stateArea.type !== "state") return null;
    var row = jc.counts[stateArea.name];
    if (!row) return 0;
    return row[occ.code] || 0;
  }

  function jobsUrl(occ, area, empty) {
    var ids = (occ && occ.category_ids) || [];
    var params = [];
    ids.forEach(function (id) {
      params.push("category_id[]=" + encodeURIComponent(id));
    });
    if (!empty && area && area.place_slug) {
      params.push("place_slug=" + encodeURIComponent(area.place_slug));
    }
    trackingParams(occ, area, empty).forEach(function (p) { params.push(p); });
    return params.length ? JOBS_BASE + "?" + params.join("&") : JOBS_BASE;
  }

  function buttonLabel(occ, area, empty) {
    var job = (occ && occ.job_label) || "pet care";
    if (empty && area && area.type === "state") {
      return "See all " + job + " jobs nationwide →";
    }
    if (area && area.type === "state") {
      return "See open " + job + " jobs in " + area.name + " →";
    }
    return "See open " + job + " jobs →";
  }

  function emptyMessage(occ, area) {
    var job = (occ && occ.job_label) || "pet care";
    return "No " + job + " openings in " + area.name + " right now — see all " + job + " jobs nationwide.";
  }

  function indexRows(data) {
    var map = {};
    data.rows.forEach(function (r) {
      map[r[0] + "|" + r[1]] = r;
    });
    return map;
  }

  function stateList(data) {
    var list = [];
    Object.keys(data.areas).forEach(function (id) {
      var a = data.areas[id];
      if (a.type === "state" && a.in_ui) list.push(a);
    });
    list.sort(function (a, b) {
      // Puerto Rico last among UI states
      if (a.prim_state === "PR" && b.prim_state !== "PR") return 1;
      if (b.prim_state === "PR" && a.prim_state !== "PR") return -1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  function metrosForState(data, stateArea, occCode) {
    if (!stateArea || !stateArea.prim_state) return [];
    var st = stateArea.prim_state;
    var list = [];
    Object.keys(data.areas).forEach(function (id) {
      var a = data.areas[id];
      if (a.type !== "metro") return;
      if ((a.states || []).indexOf(st) === -1) return;
      if (occCode && !data._idx[occCode + "|" + a.id]) return;
      list.push(a);
    });
    list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return list;
  }

  function occList(data) {
    return Object.keys(data.occupations)
      .map(function (c) { return Object.assign({ code: c }, data.occupations[c]); })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  }

  function parseQuery() {
    var q = {};
    try {
      var sp = new URLSearchParams(window.location.search || "");
      sp.forEach(function (v, k) { q[k] = v; });
    } catch (e) {}
    return q;
  }

  function css() {
    return [
      "#pch-salary-tool, #pch-salary-tool * { box-sizing: border-box; }",
      "#pch-salary-tool { font-family: Inter, 'Inter var', system-ui, -apple-system, Segoe UI, sans-serif; color: #1e293b; line-height: 1.5; }",
      "#pch-salary-tool { background: #fff; border: 1px solid #d4d4d4; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(15,110,122,.06), 0 8px 24px rgba(15,110,122,.06); }",
      "#pch-salary-tool .pch-head { background: #0f6e7a; color: #fff; padding: 16px 20px 18px; }",
      "#pch-salary-tool .pch-head h2 { margin: 0 0 4px; font-size: 1.25rem; font-weight: 650; letter-spacing: -0.02em; color: #fff; }",
      "#pch-salary-tool .pch-head p { margin: 0; font-size: .875rem; color: rgba(255,255,255,.85); }",
      "#pch-salary-tool .pch-body { padding: 20px; }",
      "#pch-salary-tool .pch-controls { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 16px; }",
      "@media (min-width: 720px) { #pch-salary-tool .pch-controls { grid-template-columns: 1.2fr .9fr 1.2fr; } }",
      "#pch-salary-tool label.pch-field { display: block; font-size: .75rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #64748b; margin-bottom: 0; }",
      "#pch-salary-tool select { width: 100%; margin-top: 6px; appearance: none; background: #fff url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%2364748b' d='M1 1l5 5 5-5'/%3E%3C/svg%3E\") no-repeat right 12px center; padding: 10px 36px 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; font-size: .95rem; color: #1e293b; }",
      "#pch-salary-tool select:focus { outline: none; border-color: #0f6e7a; box-shadow: 0 0 0 3px rgba(15,110,122,.2); }",
      "#pch-salary-tool select:disabled { background-color: #f8fafc; color: #94a3b8; }",
      "#pch-salary-tool .pch-toggle { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; }",
      "#pch-salary-tool .pch-seg { display: inline-flex; background: #f1f5f9; border-radius: 999px; padding: 3px; }",
      "#pch-salary-tool .pch-seg button { border: 0; background: transparent; color: #475569; font: inherit; font-size: .875rem; font-weight: 600; padding: 6px 14px; border-radius: 999px; cursor: pointer; }",
      "#pch-salary-tool .pch-seg button[aria-pressed='true'] { background: #0f6e7a; color: #fff; }",
      "#pch-salary-tool .pch-hero { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: flex-end; margin-bottom: 8px; }",
      "#pch-salary-tool .pch-median { font-size: 2.5rem; font-weight: 700; letter-spacing: -0.03em; color: #0f6e7a; line-height: 1.1; }",
      "#pch-salary-tool .pch-median-label { font-size: .9rem; color: #64748b; margin-bottom: 4px; }",
      "#pch-salary-tool .pch-mean { font-size: .95rem; color: #475569; }",
      "#pch-salary-tool .pch-compare { margin: 8px 0 16px; font-size: .95rem; color: #1e293b; }",
      "#pch-salary-tool .pch-compare .up { color: #0f6e7a; font-weight: 650; }",
      "#pch-salary-tool .pch-compare .down { color: #9a3412; font-weight: 650; }",
      "#pch-salary-tool .pch-compare .same { font-weight: 650; }",
      "#pch-salary-tool .pch-bar-wrap { margin: 8px 0 20px; }",
      "#pch-salary-tool .pch-bar-title { font-size: .75rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #64748b; margin-bottom: 10px; }",
      "#pch-salary-tool .pch-bar { position: relative; height: 52px; }",
      "#pch-salary-tool .pch-track { position: absolute; left: 0; right: 0; top: 22px; height: 12px; background: #e8eef0; border-radius: 999px; }",
      "#pch-salary-tool .pch-range, #pch-salary-tool .pch-iqr { position: absolute; top: 22px; height: 12px; border-radius: 999px; }",
      "#pch-salary-tool .pch-range { background: #9ec8ce; }",
      "#pch-salary-tool .pch-iqr { background: #0f6e7a; }",
      "#pch-salary-tool .pch-tick { position: absolute; top: 16px; width: 3px; height: 24px; border-radius: 2px; transform: translateX(-50%); }",
      "#pch-salary-tool .pch-tick.med { background: #0b4f57; box-shadow: 0 0 0 2px #fff; z-index: 2; }",
      "#pch-salary-tool .pch-tick.us { background: #d97706; width: 3px; z-index: 3; box-shadow: 0 0 0 2px #fff; }",
      "#pch-salary-tool .pch-tick-label { position: absolute; top: 0; transform: translateX(-50%); font-size: 10px; font-weight: 600; color: #d97706; white-space: nowrap; }",
      "#pch-salary-tool .pch-scale { display: flex; justify-content: space-between; font-size: .75rem; color: #64748b; margin-top: 6px; gap: 8px; }",
      "#pch-salary-tool .pch-legend { display: flex; flex-wrap: wrap; gap: 10px 16px; font-size: .75rem; color: #475569; margin-top: 8px; }",
      "#pch-salary-tool .pch-swatch { display: inline-block; width: 12px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }",
      "#pch-salary-tool .pch-table { width: 100%; border-collapse: collapse; font-size: .9rem; margin: 0 0 16px; }",
      "#pch-salary-tool .pch-table th, #pch-salary-tool .pch-table td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e5e7eb; }",
      "#pch-salary-tool .pch-table th { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-weight: 600; }",
      "#pch-salary-tool .pch-table td.num { font-variant-numeric: tabular-nums; }",
      "#pch-salary-tool .pch-note { background: #f0f7f8; border-left: 3px solid #0f6e7a; padding: 10px 12px; font-size: .875rem; color: #334155; margin: 0 0 16px; border-radius: 0 8px 8px 0; }",
      "#pch-salary-tool .pch-na { background: #fff7ed; border-left-color: #d97706; }",
      "#pch-salary-tool .pch-emp { font-size: .9rem; color: #475569; margin: 0 0 16px; }",
      "#pch-salary-tool .pch-cta { display: inline-block; background: #0f6e7a; color: #fff !important; text-decoration: none; font-weight: 650; font-size: .95rem; padding: 12px 18px; border-radius: 8px; text-align: center; }",
      "#pch-salary-tool .pch-cta:hover { background: #128291; }",
      "#pch-salary-tool .pch-cta-wrap { margin: 4px 0 16px; } #pch-salary-tool .pch-cta { display: inline-block; } #pch-salary-tool .pch-empty { font-size: .9rem; color: #475569; margin: 0 0 8px; } @media (max-width: 719px) { #pch-salary-tool .pch-cta { display: block; width: 100%; } }",
      "#pch-salary-tool .pch-news { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; }",
      "#pch-salary-tool .pch-news p { margin: 0 0 4px; font-size: .95rem; }",
      "#pch-salary-tool .pch-news a { color: #0f6e7a; font-weight: 650; }",
      "#pch-salary-tool .pch-source { margin: 14px 0 0; font-size: .75rem; color: #64748b; }",
      "#pch-salary-tool .pch-source a { color: #0f6e7a; }",
      "#pch-salary-tool .pch-na-big { font-size: 2rem; font-weight: 700; color: #78716c; }"
    ].join("\n");
  }

  function renderBar(mount, local, national, hourly) {
    mount.innerHTML = "";
    var keys = hourly
      ? { p10: FIELD.h10, p25: FIELD.h25, med: FIELD.hMed, p75: FIELD.h75, p90: FIELD.h90 }
      : { p10: FIELD.a10, p25: FIELD.a25, med: FIELD.aMed, p75: FIELD.a75, p90: FIELD.a90 };
    var l10 = local && local[keys.p10], l90 = local && local[keys.p90];
    var lmed = local && local[keys.med];
    var nmed = national && national[keys.med];
    var n10 = national && national[keys.p10], n90 = national && national[keys.p90];
    var vals = [l10, l90, lmed, nmed, n10, n90].filter(function (v) { return v != null; });
    if (!vals.length || lmed == null && l10 == null) {
      mount.appendChild(el("p", { class: "pch-emp", text: "A pay range is not published for this selection." }));
      return;
    }
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    if (min === max) { min = min * 0.85; max = max * 1.15; }
    var pad = (max - min) * 0.06;
    min -= pad; max += pad;
    function left(v) { return ((v - min) / (max - min)) * 100; }
    function width(a, b) { return Math.max(0, left(b) - left(a)); }

    var bar = el("div", { class: "pch-bar", role: "img" });
    var lo = fmtMoney(l10, hourly), hi = fmtMoney(l90, hourly), mid = fmtMoney(lmed, hourly);
    bar.setAttribute(
      "aria-label",
      "Pay range from " + lo + " at the 10th percentile to " + hi + " at the 90th. Median " + mid +
        (nmed != null ? ". U.S. median " + fmtMoney(nmed, hourly) : "") + "."
    );
    bar.appendChild(el("div", { class: "pch-track" }));
    if (l10 != null && l90 != null) {
      var range = el("div", { class: "pch-range" });
      range.style.left = left(l10) + "%";
      range.style.width = width(l10, l90) + "%";
      bar.appendChild(range);
    }
    if (local && local[keys.p25] != null && local[keys.p75] != null) {
      var iqr = el("div", { class: "pch-iqr" });
      iqr.style.left = left(local[keys.p25]) + "%";
      iqr.style.width = width(local[keys.p25], local[keys.p75]) + "%";
      bar.appendChild(iqr);
    }
    if (lmed != null) {
      var t = el("div", { class: "pch-tick med", title: "Median " + mid });
      t.style.left = left(lmed) + "%";
      bar.appendChild(t);
    }
    if (nmed != null && !(local && local[1] === "US")) {
      var us = el("div", { class: "pch-tick us", title: "U.S. median " + fmtMoney(nmed, hourly) });
      us.style.left = left(nmed) + "%";
      bar.appendChild(us);
      var lab = el("div", { class: "pch-tick-label", text: "U.S. median" });
      var pos = left(nmed);
      lab.style.left = pos + "%";
      if (pos < 18) { lab.style.transform = "none"; lab.style.left = pos + "%"; }
      if (pos > 82) { lab.style.transform = "translateX(-100%)"; }
      bar.appendChild(lab);
    }
    mount.appendChild(el("div", { class: "pch-bar-title", text: "Pay range (10th to 90th percentile)" }));
    mount.appendChild(bar);
    mount.appendChild(el("div", { class: "pch-scale" }, [
      el("span", { text: "10th: " + lo }),
      el("span", { text: "Median: " + mid }),
      el("span", { text: "90th: " + hi })
    ]));
    var legend = el("div", { class: "pch-legend" }, [
      el("span", { html: "<span class='pch-swatch' style='background:#9ec8ce'></span>10th–90th" }),
      el("span", { html: "<span class='pch-swatch' style='background:#0f6e7a'></span>Middle 50% (25th–75th)" }),
      el("span", { html: "<span class='pch-swatch' style='background:#0b4f57;height:12px;width:3px'></span>Median" })
    ]);
    if (nmed != null && !(local && local[1] === "US")) {
      legend.appendChild(el("span", { html: "<span class='pch-swatch' style='background:#d97706;height:12px;width:3px'></span>U.S. median" }));
    }
    mount.appendChild(legend);
  }

  function compareSentence(local, national, hourly, area) {
    if (!local || !national) return "";
    var lk = hourly ? FIELD.hMed : FIELD.aMed;
    var lv = local[lk], nv = national[lk];
    if (local[1] === "US") {
      return "This is the national median for this occupation in May 2025.";
    }
    if (lv == null || nv == null) return "";
    var pct = pctDiff(lv, nv);
    var diff = lv - nv;
    var abs = fmtMoney(Math.abs(diff), hourly);
    var where = area && area.type === "metro" ? area.name : (area ? area.name : "this area");
    if (Math.abs(pct) < 0.5) {
      return "The median in " + where + " is about the same as the U.S. median (" + fmtMoney(nv, hourly) + ").";
    }
    var rounded = Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.round(Math.abs(pct) * 10) / 10;
    var dir = pct > 0 ? "higher than" : "lower than";
    var cls = pct > 0 ? "up" : "down";
    return (
      "The median in " + where + " is <span class='" + cls + "'>" + rounded + "% " + dir +
      "</span> the U.S. median (" + fmtMoney(lv, hourly) + " vs. " + fmtMoney(nv, hourly) +
      ", " + abs + (pct > 0 ? " more" : " less") + ")."
    );
  }

  function mountWidget(root, data) {
    data._idx = indexRows(data);
    var occs = occList(data);
    var states = stateList(data);
    var q = parseQuery();
    var startOcc = q.occ || q.job || "29-2056";
    if (!data.occupations[startOcc]) startOcc = "29-2056";
    var startState = q.state || "US";
    if (startState !== "US" && !data.areas[startState]) {
      // allow CA / California
      Object.keys(data.areas).some(function (id) {
        var a = data.areas[id];
        if (a.type === "state" && (a.prim_state === startState.toUpperCase() || a.name.toLowerCase() === startState.toLowerCase())) {
          startState = id;
          return true;
        }
        return false;
      });
      if (!data.areas[startState]) startState = "US";
    }
    var startMetro = q.metro || "";

    if (!$("#pch-salary-widget-css")) {
      var st = el("style", { id: "pch-salary-widget-css" });
      st.textContent = css();
      document.head.appendChild(st);
    }

    root.innerHTML = "";
    var head = el("div", { class: "pch-head" }, [
      el("h2", { text: "Pet care salary calculator" }),
      el("p", { text: "Official U.S. pay data, by job, state and metro." })
    ]);
    var body = el("div", { class: "pch-body" });
    var occSel = el("select", { id: "pch-occ", "aria-label": "Job" });
    occs.forEach(function (o) {
      occSel.appendChild(el("option", { value: o.code, text: o.label, selected: o.code === startOcc }));
    });
    var stateSel = el("select", { id: "pch-state", "aria-label": "State" });
    stateSel.appendChild(el("option", { value: "US", text: "United States (national)", selected: startState === "US" }));
    states.forEach(function (s) {
      stateSel.appendChild(el("option", { value: s.id, text: s.name, selected: s.id === startState }));
    });
    var metroSel = el("select", { id: "pch-metro", "aria-label": "Metro area" });
    var controls = el("div", { class: "pch-controls" }, [
      el("label", { class: "pch-field" }, ["Job", occSel]),
      el("label", { class: "pch-field" }, ["State", stateSel]),
      el("label", { class: "pch-field" }, ["Metro (optional)", metroSel])
    ]);
    var hourly = false;
    var annBtn = el("button", { type: "button", "aria-pressed": "true", text: "Annual" });
    var hrBtn = el("button", { type: "button", "aria-pressed": "false", text: "Hourly" });
    var seg = el("div", { class: "pch-seg", role: "group", "aria-label": "Pay unit" }, [annBtn, hrBtn]);
    var toggle = el("div", { class: "pch-toggle" }, [seg]);
    var hero = el("div", { class: "pch-hero" });
    var compare = el("p", { class: "pch-compare" });
    var barWrap = el("div", { class: "pch-bar-wrap" });
    var tableWrap = el("div");
    var note = el("div");
    var emp = el("p", { class: "pch-emp" });
    var ctaWrap = el("div", { class: "pch-cta-wrap" });
    var news = el("div", { class: "pch-news" }, [
      el("p", { html: "<strong>Get new pet care jobs every week.</strong>" }),
      el("p", { html: "<a href='" + NEWSLETTER + "' target='_blank' rel='noopener'>Subscribe to the free Pet Care Hire newsletter →</a>" })
    ]);
    var citation = (data.meta && data.meta.citation) || "U.S. Bureau of Labor Statistics, Occupational Employment and Wage Statistics, May 2025";
    var source = el("p", { class: "pch-source", html:
      "Source: <a href='" + SOURCE_URL + "' target='_blank' rel='noopener'>U.S. Bureau of Labor Statistics, OEWS May 2025</a>. " +
      "Payroll estimates; excludes the self-employed. Suppressed values are shown as n/a. " +
      "Percentiles describe the wage distribution, not years of experience."
    });

    body.appendChild(controls);
    body.appendChild(toggle);
    body.appendChild(hero);
    body.appendChild(compare);
    body.appendChild(barWrap);
    body.appendChild(tableWrap);
    body.appendChild(note);
    body.appendChild(emp);
    body.appendChild(ctaWrap);
    body.appendChild(news);
    body.appendChild(source);
    root.appendChild(head);
    root.appendChild(body);

    function fillMetros() {
      var occ = occSel.value;
      var st = stateSel.value;
      var prev = metroSel.value || startMetro;
      metroSel.innerHTML = "";
      if (st === "US") {
        metroSel.appendChild(el("option", { value: "", text: "All U.S. (pick a state first)" }));
        metroSel.disabled = true;
        metroSel.value = "";
        return;
      }
      metroSel.disabled = false;
      var area = data.areas[st];
      metroSel.appendChild(el("option", { value: "", text: "All of " + area.name }));
      metrosForState(data, area, occ).forEach(function (m) {
        metroSel.appendChild(el("option", { value: m.id, text: m.name, selected: m.id === prev }));
      });
      if (prev && !data._idx[occ + "|" + prev]) metroSel.value = "";
    }

    function currentAreaId() {
      return metroSel.value || stateSel.value || "US";
    }

    function update() {
      var occCode = occSel.value;
      var occ = Object.assign({ code: occCode }, data.occupations[occCode]);
      var areaId = currentAreaId();
      var area = data.areas[areaId];
      var stateArea = data.areas[stateSel.value];
      var local = data._idx[occCode + "|" + areaId];
      var national = data._idx[occCode + "|US"];
      var isHourly = hourly;

      hero.innerHTML = "";
      var med = local && local[isHourly ? FIELD.hMed : FIELD.aMed];
      var mean = local && local[isHourly ? FIELD.hMean : FIELD.aMean];
      var medBox = el("div");
      medBox.appendChild(el("div", { class: "pch-median-label", text: "Median pay · " + (area ? area.name : "") }));
      if (med == null) {
        medBox.appendChild(el("div", { class: "pch-na-big", text: "n/a" }));
      } else {
        medBox.appendChild(el("div", { class: "pch-median", text: fmtMoney(med, isHourly) }));
      }
      if (mean != null) {
        medBox.appendChild(el("div", { class: "pch-mean", text: "Average (mean): " + fmtMoney(mean, isHourly) + (isHourly ? "/hour" : "/year") }));
      } else if (local) {
        medBox.appendChild(el("div", { class: "pch-mean", text: "Average (mean): n/a" }));
      }
      hero.appendChild(medBox);

      compare.innerHTML = compareSentence(local, national, isHourly, area);

      renderBar(barWrap, local, national, isHourly);

      tableWrap.innerHTML = "";
      var rows = [
        ["10th percentile", FIELD.h10, FIELD.a10],
        ["25th percentile", FIELD.h25, FIELD.a25],
        ["Median (50th)", FIELD.hMed, FIELD.aMed],
        ["75th percentile", FIELD.h75, FIELD.a75],
        ["90th percentile", FIELD.h90, FIELD.a90],
        ["Average (mean)", FIELD.hMean, FIELD.aMean]
      ];
      var table = el("table", { class: "pch-table" });
      var thead = el("thead", {}, [el("tr", {}, [el("th", { text: "Measure" }), el("th", { text: "Hourly" }), el("th", { text: "Annual" })])]);
      var tbody = el("tbody");
      rows.forEach(function (r) {
        var tr = el("tr", {}, [
          el("td", { text: r[0] }),
          el("td", { class: "num", text: local ? fmtMoney(local[r[1]], true) : "n/a" }),
          el("td", { class: "num", text: local ? fmtMoney(local[r[2]], false) : "n/a" })
        ]);
        tbody.appendChild(tr);
      });
      table.appendChild(thead);
      table.appendChild(tbody);
      tableWrap.appendChild(table);

      note.innerHTML = "";
      if (occ.note) {
        note.appendChild(el("div", { class: "pch-note", text: occ.note }));
      }
      if (!local) {
        note.appendChild(el("div", { class: "pch-note pch-na", text:
          "BLS did not publish a " + occ.short.toLowerCase() + " estimate for " + (area && area.name ? area.name : "this area") + " in May 2025. Figures are not guessed."
        }));
      } else if (med == null) {
        note.appendChild(el("div", { class: "pch-note pch-na", text:
          "BLS suppressed the wage estimate for " + occ.short.toLowerCase() + "s in " + area.name + " (shown as n/a). Employment may still be published. Numbers are never invented."
        }));
      }

      if (local && local[FIELD.emp] != null) {
        emp.textContent = "BLS counted about " + fmtEmp(local[FIELD.emp]) + " " +
          occ.short.toLowerCase() + (String(occ.short).toLowerCase().endsWith("s") ? "" : "s") +
          " on payrolls in " + area.name + " in May 2025.";
      } else if (local) {
        emp.textContent = "Employment for this selection is n/a (BLS suppressed the estimate).";
      } else {
        emp.textContent = "";
      }

      ctaWrap.innerHTML = "";
      // Job links use the state (or national) filter — metros do not have verified place slugs.
      var linkArea = (area && area.type === "metro") ? stateArea : area;
      if (stateSel.value === "US") linkArea = data.areas.US || { type: "national", name: "United States" };
      var stateLink = (linkArea && linkArea.type === "state") ? linkArea : null;
      var empty = false;
      if (stateLink) {
        var openings = jobCount(data, occ, stateLink);
        if (openings === 0) empty = true;
      }
      if (empty) {
        ctaWrap.appendChild(el("p", { class: "pch-empty", text: emptyMessage(occ, stateLink) }));
      }
      var a = el("a", {
        class: "pch-cta",
        href: jobsUrl(occ, stateLink, empty),
        text: buttonLabel(occ, stateLink, empty)
      });
      a.setAttribute("rel", "noopener");
      ctaWrap.appendChild(a);
    }

    function setUnit(isHourly) {
      hourly = isHourly;
      annBtn.setAttribute("aria-pressed", isHourly ? "false" : "true");
      hrBtn.setAttribute("aria-pressed", isHourly ? "true" : "false");
      update();
    }
    annBtn.addEventListener("click", function () { setUnit(false); });
    hrBtn.addEventListener("click", function () { setUnit(true); });
    occSel.addEventListener("change", function () { fillMetros(); update(); });
    stateSel.addEventListener("change", function () { startMetro = ""; metroSel.value = ""; fillMetros(); update(); });
    metroSel.addEventListener("change", update);

    fillMetros();
    if (startMetro) {
      metroSel.value = startMetro;
      if (metroSel.value !== startMetro) metroSel.value = "";
    }
    update();
  }

  function sha384Sri(text) {
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest("SHA-384", bytes).then(function (hash) {
      var arr = new Uint8Array(hash);
      var bin = "";
      for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
      return "sha384-" + btoa(bin);
    });
  }

  function loadData(root, cb) {
    if (window.PCH_OEWS_DATA) { cb(window.PCH_OEWS_DATA); return; }
    var tag = document.getElementById("pch-oews-data");
    if (tag && tag.textContent) {
      cb(JSON.parse(tag.textContent));
      return;
    }
    var src = root.getAttribute("data-src");
    var integrity = root.getAttribute("data-src-integrity") || window.PCH_OEWS_INTEGRITY;
    if (!src) { cb(null); return; }
    fetch(src, { credentials: "omit", cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("Could not load salary data (" + r.status + ")");
        return r.text();
      })
      .then(function (text) {
        var next = function () { return JSON.parse(text); };
        if (!integrity) return next();
        if (!window.crypto || !crypto.subtle) {
          throw new Error("This browser cannot verify the salary data file.");
        }
        return sha384Sri(text).then(function (got) {
          if (got !== integrity) {
            throw new Error("Salary data failed its integrity check and was not used.");
          }
          return next();
        });
      })
      .then(cb)
      .catch(function (err) {
        root.innerHTML = "<p style='padding:16px'>The salary calculator could not load its data. " +
          String(err.message || err) + "</p>";
      });
  }

  function boot() {
    var root = document.getElementById("pch-salary-tool");
    if (!root) return;
    loadData(root, function (data) {
      if (!data) {
        root.innerHTML = "<p style='padding:16px'>Salary data is missing.</p>";
        return;
      }
      mountWidget(root, data);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
