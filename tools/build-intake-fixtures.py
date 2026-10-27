"""Small fictional inputs for rejection/review acceptance tests, not geographic data."""
from pathlib import Path
import sys,osmium
output=Path(sys.argv[1]);output.mkdir(exist_ok=True)
fixtures={
 'missing-way-node':'<node id="1" lat="0" lon="0" version="1"/><way id="2" version="1"><nd ref="1"/><nd ref="999"/></way>',
 'missing-relation-member':'<node id="1" lat="0" lon="0" version="1"/><relation id="3" version="1"><member type="node" ref="999" role="fixture"/><tag k="type" v="collection"/></relation>',
}
for name,objects in fixtures.items():
    xml=output/(name+'.osm');xml.write_text('<osm version="0.6" generator="atlas-intake-test">'+objects+'</osm>',encoding='utf-8')
    with osmium.SimpleWriter(str(output/(name+'.osm.pbf')),overwrite=True) as writer:
        for obj in osmium.FileProcessor(xml):writer.add(obj)
    xml.unlink()
(output/'malformed.osm.pbf').write_bytes(b'not a PBF; fictional failure fixture')
