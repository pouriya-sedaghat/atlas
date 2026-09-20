# ADR-006: A web-based Atlas Studio

- Status: accepted
- Date: 2026-09-20

## Context

Atlas needs a way to look at what it imported. Counters in a log tell you four
features were emitted; they do not tell you the geometry is inside out, or that
a road was silently dropped.

Studio is a debugging tool first. Its audience is whoever is working on Atlas.

## Decision

Build Studio as a small TypeScript application rendered with MapLibre GL JS,
served by Vite, with no UI framework. The DOM here is a handful of panels; React
or Vue would add a dependency and a build story to avoid roughly two hundred
lines of straightforward DOM code.

The map style is blank and local: a background layer plus the Atlas GeoJSON
source. There is no base map, no tile server and no API key, so Studio works
offline and nothing about Atlas depends on a third-party tile service.

Studio talks to Atlas through the HTTP API only, via the Vite dev server's
proxy for `/api` and `/health`. The backend therefore needs no CORS
configuration.

Presentation lives entirely in the client. The server says `roadClass:
"residential"`; the client decides that means a blue line 1.0 units wide.

Within that client, the road modules are layered. `roadPrimitives` owns the
shared, dependency-free facts every road layer needs — the source id, the
feature-id property and `roadWidth` — and the leaf layer builders depend on it.
`roadLayers` is the composition root: it owns the base colours, the layer ids
and their order, and it assembles the leaf builders into one stack. Dependencies
point toward the primitives and never back toward the composition root.

Everything from the API is treated as untrusted text and written with
`textContent`. Names come from an OSM file.

## Consequences

- Studio shows only Atlas data, which is exactly what a debugging tool should
  show; it is also not a general-purpose map viewer, and is not meant to be.
- Viewport querying is debounced and cancellable, and stale responses are
  discarded, so a fast pan cannot render an old answer over a newer one. That
  logic is isolated in `ViewportQueryController` and unit tested without a
  browser.
- Without a framework, adding substantially more UI will eventually mean
  hand-rolling state management. Revisit this if Studio grows past a debugging
  tool.
- MapLibre resolves its web worker relative to its own module URL, so the
  worker is handed to it explicitly through Vite; without that the GeoJSON
  source never finishes loading and the map stays blank.
- A new visualization concern is a new leaf module importing the primitives,
  not another edge into `roadLayers`. Before the split, `directionArrows` and
  `accessOverlay` each imported the module that composed them, so every added
  concern meant another ESM cycle that happened to work only because the
  imported bindings were not read during module initialization.
