function normalized(text) {
    return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function containsTerms(text, terms) {
    return terms.every((term) => text.includes(term));
}

function setBranch(button, children, expanded) {
    button.setAttribute("aria-expanded", String(expanded));
    children.hidden = !expanded;
}

for (const picker of document.querySelectorAll("[data-region-picker]")) {
    const search = picker.querySelector("[data-region-search]");
    const results = picker.querySelector("[data-region-results]");
    const regions = Array.from(picker.querySelectorAll("[data-region]"), (node) => {
        const button = node.querySelector(":scope > .region-row [data-toggle-branch]");
        return {
            node,
            text: normalized(node.dataset.search),
            parent: node.parentElement.closest("[data-region]"),
            button,
            children: node.querySelector(":scope > .region-children"),
            expanded: button?.dataset.expand === "true",
        };
    });

    for (const region of regions) {
        if (!region.button) continue;
        const { button, children } = region;
        button.hidden = false;
        setBranch(button, children, region.expanded);
        button.addEventListener("click", () => {
            region.expanded = !region.expanded;
            setBranch(button, children, region.expanded);
        });
    }

    search.closest("label").hidden = false;
    search.addEventListener("input", () => {
        const terms = normalized(search.value).trim().split(/\s+/).filter(Boolean);
        const visibleParents = new Set();
        let matches = 0;
        for (let index = regions.length - 1; index >= 0; index--) {
            const region = regions[index];
            const match = containsTerms(region.text, terms);
            const childMatch = visibleParents.has(region.node);
            region.node.hidden = !match && !childMatch;
            if (!region.node.hidden) visibleParents.add(region.parent);
            if (match) matches++;
            if (region.button) {
                const expanded = terms.length ? childMatch : region.expanded;
                setBranch(region.button, region.children, expanded);
                region.button.disabled = terms.length > 0;
            }
        }
        results.hidden = !terms.length;
        results.textContent = `${matches} matching region${matches === 1 ? "" : "s"}`;
    });
}

const problems = new Set(["failed", "unavailable", "integrity_failed"]);
for (const list of document.querySelectorAll("[data-file-list]")) {
    const search = list.querySelector("[data-file-search]");
    const failuresOnly = list.querySelector("[data-file-problems]");
    const results = list.querySelector("[data-file-results]");
    const rows = Array.from(list.querySelectorAll("[data-file-row]"), (row) => ({
        row,
        text: normalized(row.dataset.search),
        problem: problems.has(row.dataset.status),
    }));

    function filterFiles() {
        const terms = normalized(search.value).trim().split(/\s+/).filter(Boolean);
        let shown = 0;
        for (const { row, text, problem } of rows) {
            row.hidden = !containsTerms(text, terms) || (failuresOnly.checked && !problem);
            if (!row.hidden) shown++;
        }
        results.hidden = !terms.length && !failuresOnly.checked;
        results.textContent = `${shown} matching file${shown === 1 ? "" : "s"}`;
    }

    list.querySelector(".file-filters").hidden = false;
    search.addEventListener("input", filterFiles);
    failuresOnly.addEventListener("change", filterFiles);
}

function drawBoundary(canvas, rings) {
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const ring of rings) {
        for (const [lon, lat] of ring) {
            west = Math.min(west, lon);
            east = Math.max(east, lon);
            south = Math.min(south, lat);
            north = Math.max(north, lat);
        }
    }
    const pad = 12;
    const scale = Math.min(
        (canvas.width - 2 * pad) / (east - west || 1),
        (canvas.height - 2 * pad) / (north - south || 1),
    );
    const marginX = (canvas.width - (east - west) * scale) / 2;
    const marginY = (canvas.height - (north - south) * scale) / 2;
    const context = canvas.getContext("2d");
    context.fillStyle = "#f0f4f9";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.beginPath();
    for (const ring of rings) {
        ring.forEach(([lon, lat], index) => {
            const x = marginX + (lon - west) * scale;
            const y = marginY + (north - lat) * scale;
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
        });
        context.closePath();
    }
    context.fillStyle = "#cedeef";
    context.strokeStyle = "#28558a";
    context.lineWidth = 2;
    context.fill("evenodd");
    context.stroke();
    canvas.hidden = false;
}

for (const preview of document.querySelectorAll("[data-boundary-url]")) {
    preview.hidden = false;
    let loading = false;
    preview.addEventListener("toggle", async () => {
        const canvas = preview.querySelector("canvas");
        if (!preview.open || loading || !canvas.hidden) return;
        loading = true;
        const status = preview.querySelector("[data-boundary-status]");
        status.textContent = "Loading boundary…";
        try {
            const response = await fetch(preview.dataset.boundaryUrl, { cache: "no-store" });
            const data = await response.json();
            if (!response.ok) throw new Error();
            drawBoundary(canvas, data.rings);
            status.textContent = "";
        } catch {
            status.textContent = "The stored boundary is unavailable for preview.";
        } finally {
            loading = false;
        }
    });
}
