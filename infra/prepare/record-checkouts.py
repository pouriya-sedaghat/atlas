#!/usr/bin/env python3
"""Record pinned checkout identities using the preparation HOST's Git, without network access."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def record_checkouts(config_path, sources_dir, output_path):
    config_path = Path(config_path).resolve()
    sources_dir = Path(sources_dir).resolve()
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    checkouts = {}
    for name, source in config['sources'].items():
        checkout = sources_dir / name
        if not checkout.is_dir():
            raise ValueError(f'{name}: missing checkout directory: {checkout}')
        head = subprocess.run(
            ['git', '-C', str(checkout), 'rev-parse', 'HEAD'],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        if head != source['commit']:
            raise ValueError(f"{name}: checked out {head}, expected {source['commit']}")
        checkouts[name] = {'observed_commit': head}
        print(f'verified host checkout: {name} {head}')
    record = {
        'schema': 'seyra.verified-source-heads/1',
        'sources_dir': str(sources_dir),
        'sources_config_sha256': hashlib.sha256(config_bytes).hexdigest(),
        'checkouts': checkouts,
    }
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(output_path.name + '.partial')
    temporary.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    temporary.replace(output_path)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('usage: record-checkouts.py SOURCES_JSON SOURCES_DIR OUTPUT_JSON')
    try:
        record_checkouts(*sys.argv[1:])
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'checkout verification failed: {error}')
