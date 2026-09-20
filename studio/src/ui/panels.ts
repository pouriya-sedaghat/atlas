/** The dataset, warnings and diagnostics panels. */

import type { FeatureQueryRequest } from '../api/client.js';
import type { AtlasMeta, Bbox, CurrentDataset } from '../api/types.js';
import { formatBbox } from '../viewport/bbox.js';
import { appendRow, clear, element, formatBytes, formatMillis, formatNumber } from './dom.js';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export type QueryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; meta: AtlasMeta; request: FeatureQueryRequest }
  | { kind: 'failed'; message: string };

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  online: 'Server online',
  offline: 'Server unreachable',
};

const DATASET_LABEL: Record<CurrentDataset['status'], string> = {
  loading: 'Dataset loading',
  ready: 'Dataset ready',
  failed: 'Dataset failed',
};

/** The three state chips in the sidebar header. */
export class StatusBar {
  constructor(private readonly root: HTMLElement) {}

  render(connection: ConnectionState, dataset: CurrentDataset | null, query: QueryState): void {
    clear(this.root);
    this.root.append(chip(CONNECTION_LABEL[connection], connectionTone(connection)));

    if (dataset) {
      this.root.append(chip(DATASET_LABEL[dataset.status], datasetTone(dataset.status)));
    }

    switch (query.kind) {
      case 'loading':
        this.root.append(chip('Query loading', 'busy'));
        break;
      case 'failed':
        this.root.append(chip('Query failed', 'bad'));
        break;
      case 'ready':
        this.root.append(chip(`${formatNumber(query.meta.returned)} features`, 'good'));
        break;
      case 'idle':
        break;
    }
  }
}

function chip(label: string, tone: string): HTMLElement {
  return element('span', `chip chip-${tone}`, label);
}

function connectionTone(state: ConnectionState): string {
  return state === 'online' ? 'good' : state === 'connecting' ? 'busy' : 'bad';
}

function datasetTone(status: CurrentDataset['status']): string {
  return status === 'ready' ? 'good' : status === 'loading' ? 'busy' : 'bad';
}

/** Dataset identity, source, bounds and import counters. */
export class DatasetPanel {
  constructor(private readonly root: HTMLElement) {}

  render(dataset: CurrentDataset | null, error: string | null): void {
    clear(this.root);

    if (error) {
      this.root.append(element('p', 'note note-bad', error));
      return;
    }
    if (!dataset) {
      this.root.append(element('p', 'note', 'Contacting the Atlas server…'));
      return;
    }

    const list = element('dl', 'rows');
    appendRow(list, 'Status', DATASET_LABEL[dataset.status]);
    appendRow(list, 'Dataset ID', dataset.datasetId ?? '—');
    appendRow(list, 'Source', dataset.source?.name ?? '—');
    appendRow(list, 'Format', dataset.source?.format ?? '—');
    appendRow(list, 'Bounds', dataset.bounds ? formatBbox(dataset.bounds) : '—');

    const statistics = dataset.statistics;
    if (statistics) {
      appendRow(list, 'Import time', formatMillis(statistics.elapsedMs));
      appendRow(list, 'Features', formatNumber(statistics.featureCount));
      appendRow(
        list,
        'Nodes',
        `${formatNumber(statistics.nodesIndexed)} indexed / ${formatNumber(statistics.nodesSeen)} seen`,
      );
      appendRow(
        list,
        'Ways',
        `${formatNumber(statistics.roadWaysSelected)} roads / ${formatNumber(statistics.waysSeen)} seen`,
      );
      appendRow(
        list,
        'Emitted',
        `${formatNumber(statistics.featuresEmitted)} emitted / ${formatNumber(statistics.featuresSkipped)} skipped`,
      );
      appendRow(
        list,
        'Relations',
        `${formatNumber(statistics.relationsSeen)} counted, not interpreted`,
      );
      if (statistics.bytesRead !== undefined) {
        appendRow(list, 'Bytes read', formatBytes(statistics.bytesRead));
      }
    }
    this.root.append(list);

    if (dataset.failure) {
      const note = element('p', 'note note-bad');
      note.textContent = `${dataset.failure.message} (${dataset.failure.category})`;
      this.root.append(note);
    }
  }
}

/** Grouped import warnings with their bounded entity samples. */
export class WarningsPanel {
  constructor(private readonly root: HTMLElement) {}

  render(dataset: CurrentDataset | null): void {
    clear(this.root);
    const warnings = dataset?.warnings ?? [];
    if (warnings.length === 0) {
      this.root.append(element('p', 'note', 'No import warnings.'));
      return;
    }

    const list = element('ul', 'warnings');
    for (const warning of warnings) {
      const item = element('li', 'warning');
      const head = element('div', 'warning-head');
      head.append(
        element('code', 'warning-code', warning.code),
        element('span', 'warning-count', `${formatNumber(warning.count)}×`),
      );
      item.append(head);
      if (warning.samples.length > 0) {
        item.append(element('div', 'warning-samples', warning.samples.join(', ')));
      }
      list.append(item);
    }
    this.root.append(list);
  }
}

/** What the last viewport query cost and returned. */
export class DiagnosticsPanel {
  constructor(private readonly root: HTMLElement) {}

  render(query: QueryState, viewport: Bbox | null): void {
    clear(this.root);
    const list = element('dl', 'rows');
    appendRow(list, 'Viewport', viewport ? formatBbox(viewport) : '—');

    switch (query.kind) {
      case 'idle':
        appendRow(list, 'State', 'Waiting for a dataset');
        break;
      case 'loading':
        appendRow(list, 'State', 'Querying…');
        break;
      case 'failed':
        appendRow(list, 'State', 'Failed');
        this.root.append(list, element('p', 'note note-bad', query.message));
        return;
      case 'ready': {
        const { meta } = query;
        appendRow(list, 'State', 'Ready');
        appendRow(list, 'Dataset ID', meta.datasetId);
        appendRow(list, 'Returned', formatNumber(meta.returned));
        appendRow(list, 'Limit', formatNumber(meta.limit));
        appendRow(list, 'Truncated', meta.truncated ? 'yes' : 'no');
        if (meta.diagnostics) {
          appendRow(list, 'Examined', formatNumber(meta.diagnostics.featuresExamined));
          appendRow(list, 'Candidates', formatNumber(meta.diagnostics.candidatesFound));
          appendRow(list, 'Query time', formatMillis(meta.diagnostics.elapsedMs));
        } else {
          appendRow(list, 'Diagnostics', 'not requested');
        }
        break;
      }
    }
    this.root.append(list);
  }
}
