"use strict";
(() => {
  // frontend/similarity-page.ts
  var RunningGridSimilarityMath = {
    summarize(pair, expected) {
      const valid = (pair?.rows || []).filter(
        (row) => Number.isFinite(row.lpips)
      );
      const count = valid.length;
      return {
        count,
        complete: expected > 0 && count === expected,
        mean: count ? valid.reduce((sum, row) => sum + row.lpips, 0) / count : null,
        worst: count ? valid.reduce((worst, row) => Math.max(worst, row.lpips), 0) : null,
        different: valid.some((row) => row.settings === "different"),
        unknown: valid.some((row) => row.settings === "unknown")
      };
    },
    key(a, b) {
      return [a, b].sort().join("|");
    },
    fromReference(columns, pairs, expected, reference) {
      if (!columns.includes(reference)) {
        return [...columns];
      }
      const distances = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        if (pair.a !== reference && pair.b !== reference) {
          continue;
        }
        const score = RunningGridSimilarityMath.summarize(pair, expected);
        if (score.complete && score.mean != null) {
          distances.set(
            pair.a === reference ? pair.b : pair.a,
            score.mean
          );
        }
      }
      const others = columns.filter((key) => key !== reference);
      others.sort((a, b) => {
        const left = distances.get(a), right = distances.get(b);
        if (left == null || right == null) {
          return left == null ? right == null ? 0 : 1 : -1;
        }
        return left - right || a.localeCompare(b);
      });
      return [reference, ...others];
    },
    /** Starts with the closest complete pair, then appends the closest unused neighbor to the last column. */
    chain(columns, pairs, expected) {
      const remaining = new Set([...columns].sort());
      const distances = /* @__PURE__ */ new Map();
      const candidates = [];
      for (const pair of pairs) {
        const score = RunningGridSimilarityMath.summarize(pair, expected);
        if (score.complete && score.mean != null && pair.a !== pair.b && remaining.has(pair.a) && remaining.has(pair.b)) {
          const keys = pair.a < pair.b ? [pair.a, pair.b] : [pair.b, pair.a];
          distances.set(
            RunningGridSimilarityMath.key(...keys),
            score.mean
          );
          candidates.push({ keys, distance: score.mean });
        }
      }
      candidates.sort(
        (a, b) => a.distance - b.distance || RunningGridSimilarityMath.key(...a.keys).localeCompare(
          RunningGridSimilarityMath.key(...b.keys)
        )
      );
      const nearest = (from) => {
        let best = null;
        for (const key of remaining) {
          const distance = distances.get(
            RunningGridSimilarityMath.key(from, key)
          );
          if (distance != null && (!best || distance < best.distance)) {
            best = { key, distance };
          }
        }
        return best;
      };
      const order = [];
      while (remaining.size) {
        const next = order.length ? nearest(order[order.length - 1]) : null;
        if (next) {
          order.push(next.key);
          remaining.delete(next.key);
          continue;
        }
        const pair = candidates.find(
          (candidate) => candidate.keys.every((key) => remaining.has(key))
        );
        if (!pair) {
          order.push(...columns.filter((key) => remaining.has(key)));
          break;
        }
        const [a, b] = pair.keys;
        remaining.delete(a);
        remaining.delete(b);
        if ((nearest(a)?.distance ?? Infinity) < (nearest(b)?.distance ?? Infinity)) {
          order.push(b, a);
        } else {
          order.push(a, b);
        }
      }
      return order;
    }
  };
  var RunningGridSimilarityPage = class {
    constructor(data) {
      this.data = data;
      const axis = typeof rawData === "undefined" ? null : rawData.axes[0];
      const table = document.getElementById("image_table");
      if (!axis || !table || !axis.values.length) {
        return;
      }
      this.axis = axis;
      this.table = table;
      this.original = [...this.axis.values];
      this.customOrder = this.original.map((value) => value.key);
      this.lastReference = this.original[0].key;
      this.storageKey = `running-grid-view-v1:${window.location.pathname}`;
      this.pairs = new Map(
        data.pairs.map((pair) => [
          RunningGridSimilarityMath.key(pair.a, pair.b),
          pair
        ])
      );
      this.titles = new Map(
        this.original.map((value) => [value.key, value.title])
      );
      this.panel = document.createElement("details");
      this.panel.className = "running-similarity";
      this.panel.open = true;
      this.panel.setAttribute("aria-label", "Grid view");
      this.panel.innerHTML = `
            <summary class="running-similarity-summary">View <span class="running-similarity-count"></span></summary>
            <div class="running-similarity-content">
            <div class="running-similarity-toolbar">
                <label class="running-similarity-select-field">Column order <select class="running-similarity-order">
                    <option value="saved">Saved order</option><option value="custom">Custom order</option><option value="chain">Similarity chain</option>
                    <option value="reference">Similarity to selected column</option>
                </select></label>
                <label class="running-similarity-select-field running-similarity-reference-field" hidden>Reference column
                    <select class="running-similarity-reference"><option value="">None — restore previous order</option></select>
                </label>
                <label><input type="checkbox" class="running-similarity-badges"> Show row scores</label>
                <div class="running-similarity-size-controls">
                    <label title="Resize images to fit this many across the screen. Scroll sideways for the remaining columns.">Images per row
                        <input class="running-similarity-size" type="number" min="1" step="1" placeholder="Default" aria-label="Images per row">
                    </label>
                    <button class="running-similarity-size-reset" type="button" disabled>Reset size</button>
                </div>
            </div>
            <p class="running-similarity-order-note" role="status"></p>
                <div class="running-similarity-controls">
                    <span class="running-similarity-hint">Drag handles to reorder. Uncheck names to hide columns.</span>
                    <button type="button" class="running-similarity-show-all">Show all columns</button>
                </div>
                <div class="running-similarity-scroll"><table class="running-similarity-scores">
                    <thead><tr><th scope="col" aria-label="Reorder"></th><th scope="col">Show</th><th scope="col">Column</th><th scope="col">Compared with</th><th scope="col" title="Average LPIPS across matching images from these two columns. Lower means more alike.">Difference ↓</th></tr></thead>
                    <tbody></tbody></table></div>
            <p class="running-similarity-status" role="status" hidden></p>
            </div>`;
      this.table.closest(".image_table_box")?.before(this.panel);
      this.order = this.control(
        ".running-similarity-order"
      );
      this.status = this.control(".running-similarity-status");
      this.reference = this.control(
        ".running-similarity-reference"
      );
      this.badges = this.control(
        ".running-similarity-badges"
      );
      this.size = this.control(".running-similarity-size");
      for (const value of this.original) {
        const option = document.createElement("option");
        option.value = value.key;
        option.textContent = value.title;
        this.reference.appendChild(option);
      }
      const usable = data.pairs.some(
        (pair) => RunningGridSimilarityMath.summarize(pair, data.expected_rows).complete
      );
      this.control(
        '.running-similarity-order [value="chain"]'
      ).disabled = !usable;
      if (!usable) {
        this.status.hidden = false;
        this.status.textContent = "Open Running Grids and select Analyze similarity to score saved images.";
      }
      this.order.addEventListener("change", () => {
        if (this.order.value === "reference") {
          this.reference.value = this.lastReference;
          setShowVal(this.axis.id, this.reference.value, true);
        } else {
          this.unanchoredOrder = this.order.value;
          this.reference.value = "";
        }
        this.sort();
      });
      this.reference.addEventListener("change", () => {
        this.order.value = this.reference.value ? "reference" : this.unanchoredOrder;
        if (this.reference.value) {
          this.lastReference = this.reference.value;
          setShowVal(this.axis.id, this.reference.value, true);
        }
        this.sort();
      });
      this.badges.addEventListener("change", () => this.render());
      this.size.addEventListener("input", () => {
        if (this.size.validity.rangeOverflow) {
          this.size.value = this.size.max;
        }
        if (this.size.validity.valid) {
          this.imagesAcross = this.size.value ? Number(this.size.value) : 0;
          this.applyImageSizing();
          this.savePreferences();
        }
      });
      const resetSize = () => {
        this.size.value = "";
        this.imagesAcross = 0;
        this.applyImageSizing();
        this.savePreferences();
      };
      this.control(
        ".running-similarity-size-reset"
      ).addEventListener("click", resetSize);
      document.getElementById("autoScaleImages")?.addEventListener("change", resetSize);
      window.addEventListener("resize", () => this.applyImageSizing());
      this.panel.addEventListener("toggle", () => {
        this.cancelColumnDrag();
        this.savePreferences();
      });
      this.control(
        ".running-similarity-show-all"
      ).addEventListener("click", () => {
        for (const value of this.original) {
          setShowVal(this.axis.id, value.key, true);
        }
        fillTable();
        this.render();
      });
      this.control("tbody").addEventListener(
        "change",
        (event) => {
          if (event.target instanceof HTMLInputElement && event.target.matches(".running-similarity-visible")) {
            setShowVal(
              this.axis.id,
              event.target.value,
              event.target.checked
            );
            fillTable();
            this.render();
          }
        }
      );
      this.scoreBody = this.control("tbody");
      this.scoreScroll = this.control(
        ".running-similarity-scroll"
      );
      this.scoreBody.addEventListener(
        "pointerdown",
        (event) => this.startColumnDrag(event)
      );
      this.scoreBody.addEventListener(
        "pointermove",
        (event) => this.updateColumnDrag(event)
      );
      this.scoreBody.addEventListener(
        "pointerup",
        (event) => this.finishColumnDrag(event)
      );
      this.scoreBody.addEventListener(
        "pointercancel",
        () => this.cancelColumnDrag()
      );
      this.scoreBody.addEventListener(
        "lostpointercapture",
        () => this.cancelColumnDrag()
      );
      this.scoreBody.addEventListener(
        "keydown",
        (event) => this.columnDragKey(event)
      );
      this.restorePreferences(usable);
      this.observer = new MutationObserver(() => this.render());
      this.observer.observe(this.table, { childList: true });
      this.imageModal = document.getElementById("image_info_modal");
      if (this.imageModal) {
        this.imageObserver = new MutationObserver(
          () => this.renderImageIdentity()
        );
        this.imageObserver.observe(this.imageModal, { childList: true });
        this.renderImageIdentity();
      }
      this.sort();
    }
    data;
    axis;
    table;
    original;
    customOrder;
    imagesAcross = 0;
    unanchoredOrder = "saved";
    lastReference;
    storageKey;
    pairs;
    titles;
    panel;
    order;
    status;
    reference;
    badges;
    size;
    scoreBody;
    scoreScroll;
    observer;
    imageModal;
    imageObserver;
    identityImage;
    imageNameExpanded = false;
    columnDrag = null;
    control(selector) {
      const element = this.panel.querySelector(selector);
      if (!element) {
        throw new Error(`Missing grid view control: ${selector}`);
      }
      return element;
    }
    applyImageSizing() {
      const headers = this.table.querySelectorAll(
        "tr:first-child th"
      );
      const columns = Math.max(0, headers.length - 1);
      this.size.max = String(Math.max(1, columns));
      this.size.disabled = !columns;
      if (this.imagesAcross > columns && columns > 0) {
        this.imagesAcross = columns;
        this.size.value = String(columns);
      }
      this.control(
        ".running-similarity-size-reset"
      ).disabled = !this.imagesAcross;
      this.table.classList.toggle(
        "running-grid-sized",
        this.imagesAcross > 0 && columns > 0
      );
      if (!this.imagesAcross || !columns) {
        this.table.style.removeProperty("width");
        for (const header of headers) {
          header.style.removeProperty("width");
        }
        return;
      }
      const viewport = document.documentElement.clientWidth;
      let labelWidth = 1;
      const label = this.table.querySelector(".axis_label_td");
      if (label) {
        const style = getComputedStyle(label);
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 1;
        for (const text of this.table.querySelectorAll(
          ".axis_label_td b"
        )) {
          labelWidth = Math.max(
            labelWidth,
            Math.ceil(text.getBoundingClientRect().width + padding)
          );
        }
      }
      const columnWidth = Math.max(
        1,
        (viewport - labelWidth - 2) / this.imagesAcross
      );
      this.table.style.width = `${labelWidth + columnWidth * columns}px`;
      this.table.style.setProperty(
        "--running-grid-image-width",
        `${Math.max(1, columnWidth - 2)}px`
      );
      for (let i = 0; i < headers.length; i++) {
        headers[i].style.width = `${i ? columnWidth : labelWidth}px`;
      }
    }
    startColumnDrag(event) {
      const handle = event.target instanceof Element ? event.target.closest(
        ".running-similarity-grip"
      ) : null;
      const row = handle?.closest("tr");
      if (!handle || !row || handle.disabled || event.button !== 0 || !event.isPrimary || this.columnDrag) {
        return;
      }
      event.preventDefault();
      handle.focus({ preventScroll: true });
      this.columnDrag = {
        handle,
        row,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        started: false
      };
      handle.setPointerCapture(event.pointerId);
    }
    updateColumnDrag(event) {
      const drag = this.columnDrag;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.started && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) {
        drag.started = true;
        drag.row.classList.add("running-similarity-dragging");
        this.scrollColumnDrag();
      }
      if (drag.started) {
        this.markColumnDrop();
      }
    }
    markColumnDrop() {
      const drag = this.columnDrag;
      if (!drag) {
        return;
      }
      drag.target?.row.classList.remove(
        "running-similarity-drop-before",
        "running-similarity-drop-after"
      );
      drag.target = null;
      const bounds = this.scoreScroll.getBoundingClientRect();
      if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) {
        return;
      }
      const rows = Array.from(this.scoreBody.rows);
      const original = rows.indexOf(drag.row);
      rows.splice(original, 1);
      let index = rows.findIndex(
        (row2) => drag.y < row2.getBoundingClientRect().top + row2.offsetHeight / 2
      );
      const after = index < 0;
      index = after ? rows.length : index;
      if (index === original) {
        return;
      }
      const row = rows[after ? rows.length - 1 : index];
      drag.target = { row, after };
      row.classList.add(
        after ? "running-similarity-drop-after" : "running-similarity-drop-before"
      );
    }
    scrollColumnDrag() {
      const drag = this.columnDrag;
      if (!drag?.started) {
        return;
      }
      const bounds = this.scoreScroll.getBoundingClientRect();
      const top = Math.max(0, bounds.top), bottom = Math.min(window.innerHeight, bounds.bottom);
      if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= top && drag.y <= bottom) {
        this.scoreScroll.scrollTop += drag.y < top + 40 ? -8 : drag.y > bottom - 32 ? 8 : 0;
        this.markColumnDrop();
      }
      drag.frame = requestAnimationFrame(() => this.scrollColumnDrag());
    }
    cancelColumnDrag() {
      const drag = this.columnDrag;
      if (!drag) {
        return;
      }
      this.columnDrag = null;
      if (drag.frame != null) {
        cancelAnimationFrame(drag.frame);
      }
      drag.target?.row.classList.remove(
        "running-similarity-drop-before",
        "running-similarity-drop-after"
      );
      drag.row.classList.remove("running-similarity-dragging");
      if (drag.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId);
      }
    }
    finishColumnDrag(event) {
      if (!this.columnDrag || this.columnDrag.pointerId !== event.pointerId) {
        return;
      }
      this.updateColumnDrag(event);
      const { row, target } = this.columnDrag;
      this.cancelColumnDrag();
      const column = row.dataset.column;
      const targetColumn = target?.row.dataset.column;
      if (target && column && targetColumn) {
        this.moveColumn(column, targetColumn, target.after);
      }
    }
    columnDragKey(event) {
      if (event.key === "Escape") {
        this.cancelColumnDrag();
        return;
      }
      const handle = event.target instanceof Element ? event.target.closest(
        ".running-similarity-grip"
      ) : null;
      if (!handle || handle.disabled || this.columnDrag || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const keys = this.axis.values.map((value) => value.key);
      const index = keys.indexOf(handle.value);
      const after = event.key === "ArrowDown" || event.key === "End";
      const target = event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : index + (after ? 1 : -1);
      if (target >= 0 && target < keys.length && target !== index) {
        this.moveColumn(handle.value, keys[target], after);
      }
    }
    moveColumn(column, target, after) {
      const keys = this.axis.values.map((value) => value.key);
      if (column === target || !keys.includes(column) || !keys.includes(target)) {
        return;
      }
      keys.splice(keys.indexOf(column), 1);
      keys.splice(keys.indexOf(target) + (after ? 1 : 0), 0, column);
      this.customOrder = keys;
      this.order.value = this.unanchoredOrder = "custom";
      this.reference.value = "";
      this.sort();
    }
    renderImageIdentity() {
      if (!this.imageModal) {
        return;
      }
      const image = this.imageModal?.querySelector(
        ".popup_modal_img"
      );
      if (!image || image === this.identityImage) {
        return;
      }
      this.identityImage = image;
      const path = typeof popoverLastImg === "undefined" ? null : popoverLastImg?.dataset.img_path;
      if (!path) {
        return;
      }
      const parts = path.split("/");
      const values = rawData.axes.map(
        (axis, index) => axis.values.find((value) => value.key === parts[index])
      );
      if (!values[0]) {
        return;
      }
      const fullName = values[0].title;
      const shortName = this.axis.title.toLowerCase() === "model" ? fullName.split(/[\\/]/).pop()?.replace(
        /\.(safetensors|gguf|ckpt|pt|pth|sft|bin)$/i,
        ""
      ) : `${this.axis.title}: ${fullName}`;
      const badge = document.createElement("div");
      badge.className = "running-grid-image-identity";
      badge.setAttribute("aria-live", "polite");
      badge.setAttribute("aria-atomic", "true");
      const name = document.createElement("button");
      name.type = "button";
      name.className = "running-grid-image-name";
      name.title = fullName;
      name.setAttribute(
        "aria-label",
        `${this.axis.title}: ${fullName}. Toggle full name.`
      );
      const updateName = () => {
        name.textContent = this.imageNameExpanded ? fullName : shortName ?? fullName;
        name.setAttribute(
          "aria-expanded",
          this.imageNameExpanded ? "true" : "false"
        );
      };
      name.addEventListener("click", () => {
        this.imageNameExpanded = !this.imageNameExpanded;
        updateName();
      });
      updateName();
      badge.appendChild(name);
      const coordinates = document.createElement("div");
      coordinates.className = "running-grid-image-coordinates";
      coordinates.textContent = rawData.axes.slice(1).map((axis, index) => {
        const value = values[index + 1];
        return value ? `${axis.title} ${value.title}` : "";
      }).filter(Boolean).join(" · ");
      if (coordinates.textContent) {
        badge.appendChild(coordinates);
      }
      this.imageModal.appendChild(badge);
    }
    restorePreferences(usable) {
      try {
        const stored = JSON.parse(
          localStorage.getItem(this.storageKey) ?? "null"
        );
        const saved = stored;
        if (!saved || typeof saved !== "object") {
          return;
        }
        const keys = this.original.map((value) => value.key);
        if (Array.isArray(saved.customOrder)) {
          this.customOrder = [
            .../* @__PURE__ */ new Set([
              ...saved.customOrder.filter(
                (key) => typeof key === "string" && keys.includes(key)
              ),
              ...keys
            ])
          ];
        }
        this.unanchoredOrder = saved.unanchoredOrder === "custom" ? "custom" : saved.unanchoredOrder === "chain" && usable ? "chain" : "saved";
        if (typeof saved.reference === "string" && this.titles.has(saved.reference)) {
          this.lastReference = saved.reference;
        }
        this.order.value = saved.order === "reference" ? "reference" : saved.order === "custom" ? "custom" : saved.order === "chain" && usable ? "chain" : "saved";
        if (typeof saved.imagesAcross === "number" && Number.isSafeInteger(saved.imagesAcross) && saved.imagesAcross >= 1) {
          this.imagesAcross = saved.imagesAcross;
          this.size.value = String(saved.imagesAcross);
        }
        this.reference.value = this.order.value === "reference" ? this.lastReference : "";
        this.badges.checked = saved.badges === true;
        this.panel.open = saved.panelOpen !== false;
        if (saved.visibility && typeof saved.visibility === "object") {
          const visibility = saved.visibility;
          for (const value of this.original) {
            const visible = visibility[value.key];
            if (typeof visible === "boolean") {
              setShowVal(this.axis.id, value.key, visible);
            }
          }
        }
      } catch {
      }
    }
    savePreferences() {
      try {
        localStorage.setItem(
          this.storageKey,
          JSON.stringify({
            order: this.order.value,
            reference: this.lastReference,
            unanchoredOrder: this.unanchoredOrder,
            customOrder: this.customOrder,
            imagesAcross: this.imagesAcross,
            badges: this.badges.checked,
            panelOpen: this.panel.open,
            visibility: Object.fromEntries(
              this.original.map((value) => [
                value.key,
                canShowVal(this.axis.id, value.key)
              ])
            )
          })
        );
      } catch {
      }
    }
    sort() {
      this.cancelColumnDrag();
      let order = this.original.map((value) => value.key);
      if (this.reference.value) {
        order = RunningGridSimilarityMath.fromReference(
          order,
          this.data.pairs,
          this.data.expected_rows,
          this.reference.value
        );
      } else if (this.order.value === "chain") {
        order = RunningGridSimilarityMath.chain(
          order,
          this.data.pairs,
          this.data.expected_rows
        );
      } else if (this.order.value === "custom") {
        order = this.customOrder;
      }
      const rank = new Map(order.map((key, index) => [key, index]));
      this.axis.values = [...this.original].sort(
        (a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0)
      );
      if (this.order.value !== "saved") {
        const x = document.getElementById(
          `x_${this.axis.id}`
        );
        if (x && !x.checked) {
          if (getCurrentSelectedAxis("y") === this.axis.id) {
            document.getElementById(`y_${getCurrentSelectedAxis("x")}`)?.click();
          }
          x.click();
        }
      }
      fillTable();
      this.render();
    }
    references() {
      const result = /* @__PURE__ */ new Map();
      let previous = null;
      for (const value of this.axis.values) {
        if (!canShowVal(this.axis.id, value.key)) {
          continue;
        }
        result.set(value.key, this.reference.value || previous);
        previous = value.key;
      }
      return result;
    }
    render() {
      this.cancelColumnDrag();
      this.applyImageSizing();
      this.control(
        ".running-similarity-reference-field"
      ).hidden = this.order.value !== "reference";
      const shown = this.axis.values.filter(
        (value) => canShowVal(this.axis.id, value.key)
      ).length;
      this.control(".running-similarity-count").textContent = `${shown} of ${this.original.length} shown`;
      this.control(
        ".running-similarity-show-all"
      ).disabled = shown === this.original.length;
      const orderNote = this.reference.value ? `Each column is compared with ${this.titles.get(this.reference.value)}${canShowVal(this.axis.id, this.reference.value) ? " (first column)" : " (hidden reference)"}.` : this.order.value === "chain" ? "Closest pair first, then the closest remaining column. Each column is compared with its visible neighbor on the left." : `${this.order.value === "custom" ? "Custom order, saved in this browser." : "Saved gallery order."} Each column is compared with its visible neighbor on the left.`;
      this.control(".running-similarity-order-note").textContent = `${orderNote} Difference averages matching image pairs; lower means more alike.`;
      const body = this.control("tbody");
      const active = document.activeElement;
      const focused = body.contains(active) && (active instanceof HTMLButtonElement || active instanceof HTMLInputElement) ? active.value : null;
      const gripFocused = document.activeElement?.classList.contains(
        "running-similarity-grip"
      );
      const scroll = this.control(
        ".running-similarity-scroll"
      );
      const scrollTop = scroll.scrollTop, scrollLeft = scroll.scrollLeft;
      const rows = document.createDocumentFragment();
      let focusedControl = null;
      const references = this.references();
      for (const value of this.axis.values) {
        const column = value.key, reference = references.get(column);
        const visible = canShowVal(this.axis.id, column);
        const compared = reference != null && column !== reference;
        const pair = reference == null ? void 0 : this.pairs.get(
          RunningGridSimilarityMath.key(column, reference)
        );
        const score = RunningGridSimilarityMath.summarize(
          pair,
          this.data.expected_rows
        );
        const row = document.createElement("tr");
        row.dataset.column = column;
        row.dataset.reference = reference ?? "";
        row.classList.toggle("running-similarity-hidden-column", !visible);
        const gripCell = document.createElement("td");
        const grip = document.createElement("button");
        grip.type = "button";
        grip.className = "running-similarity-grip";
        grip.value = column;
        grip.textContent = "⠿";
        grip.disabled = this.axis.values.length < 2;
        grip.setAttribute("aria-label", `Reorder ${value.title}`);
        grip.title = "Drag to reorder. Keyboard: Up/Down, Home/End. Changes stay in this browser.";
        gripCell.appendChild(grip);
        row.appendChild(gripCell);
        const checkCell = document.createElement("td");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "running-similarity-visible";
        checkbox.id = `running-similarity-visible-${column}`;
        checkbox.value = column;
        checkbox.checked = visible;
        checkbox.setAttribute("aria-label", `Show ${value.title}`);
        checkCell.appendChild(checkbox);
        row.appendChild(checkCell);
        const nameCell = document.createElement("td");
        const nameLabel = document.createElement("label");
        nameLabel.className = "running-similarity-column-name";
        nameLabel.htmlFor = checkbox.id;
        nameLabel.textContent = value.title;
        nameCell.appendChild(nameLabel);
        row.appendChild(nameCell);
        const values = [
          compared ? this.titles.get(reference) : !visible ? "Hidden" : column === reference ? "Reference column" : "First visible column",
          compared ? score.mean != null ? `${score.mean.toFixed(5)}${score.complete ? "" : " (partial)"}` : "Not scored" : "—"
        ];
        for (const text of values) {
          const cell = document.createElement("td");
          cell.textContent = text ?? "";
          row.appendChild(cell);
        }
        if (compared) {
          row.lastElementChild.title = `${value.title} compared with ${this.titles.get(reference)}. Average LPIPS over ${score.count} of ${this.data.expected_rows} matching image pairs. Lower means more alike.`;
        }
        rows.appendChild(row);
        if (focused === column) {
          focusedControl = gripFocused ? grip : checkbox;
        }
      }
      body.replaceChildren(rows);
      focusedControl?.focus({ preventScroll: true });
      scroll.scrollTop = scrollTop;
      scroll.scrollLeft = scrollLeft;
      this.renderBadges(references);
      this.savePreferences();
    }
    /** Matches every visible image by its full stable path, including all hidden axis coordinates. */
    renderBadges(references) {
      for (const old of this.table.querySelectorAll(
        ".running-similarity-badge"
      )) {
        old.remove();
      }
      if (!this.badges.checked) {
        return;
      }
      for (const image of this.table.querySelectorAll(
        ".table_img[data-img_path]"
      )) {
        const parts = image.dataset.img_path?.split("/");
        const column = parts?.shift();
        if (!parts || !column) {
          continue;
        }
        const rowKey = parts.join("/");
        const reference = references.get(column);
        const pair = reference == null ? void 0 : this.pairs.get(
          RunningGridSimilarityMath.key(column, reference)
        );
        const row = pair?.rows.find(
          (item) => item.key === rowKey && Number.isFinite(item.lpips)
        );
        const badge = document.createElement("div");
        badge.className = "running-similarity-badge";
        badge.dataset.reference = reference || "";
        const label = this.reference.value ? "selected reference" : "previous column";
        badge.textContent = reference == null ? "First column" : column === reference ? "Reference" : row ? `vs ${label} · LPIPS ${row.lpips.toFixed(5)}` : `Not scored vs ${label}`;
        badge.title = reference == null ? "No previous visible column." : `Compared with ${this.titles.get(reference)}, same row.`;
        image.parentElement?.appendChild(badge);
      }
    }
  };
  if (typeof window !== "undefined") {
    window.RunningGridSimilarityMath = RunningGridSimilarityMath;
    window.RunningGridSimilarityPage = RunningGridSimilarityPage;
    if (window.runningGridSimilarityData && typeof document !== "undefined") {
      window.runningGridSimilarityPage = new RunningGridSimilarityPage(
        window.runningGridSimilarityData
      );
    }
  }
})();
//# sourceMappingURL=similarity-page.js.map
