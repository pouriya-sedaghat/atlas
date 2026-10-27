"""Extend the fictional catalog fixture with archive edge cases, never real places."""
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import osmium

root = Path(__file__).resolve().parents[2]
document = ET.parse(root/'fixtures/osm/synthetic-v1.osm').getroot()
node = ET.Element('node',id='100000001',lon='-0.0000001',lat='0.1234567',version='3',timestamp='2026-10-25T12:13:14Z',uid='7',user='fixture-user',changeset='42')
ET.SubElement(node,'tag',k='unknown:feature',v='kept "quotes" \\ slash / فارسی')
ET.SubElement(node,'tag',k='😀key',v='unicode')
ET.SubElement(node,'tag',k='\ue000key',v='ordering')
empty_way = ET.Element('way',id='100000002')
empty_relation = ET.Element('relation',id='100000003')
relation = ET.Element('relation',id='100000004',version='1')
ET.SubElement(relation,'member',type='node',ref='100000001',role='a "quoted" \\ نقش')
ET.SubElement(relation,'member',type='node',ref='100000001',role='second')
ET.SubElement(relation,'member',type='relation',ref='100000003',role='nested')
items = [e for e in document if e.tag in ('node','way','relation')]+[node,empty_way,empty_relation,relation]
order = {'node':0,'way':1,'relation':2}
items.sort(key=lambda e:(order[e.tag],int(e.attrib['id'])))
temporary = Path(sys.argv[1]).with_suffix('.osm')
output = ET.Element('osm',version='0.6',generator='atlas-conformance-fixture')
output.extend(items)
ET.ElementTree(output).write(temporary,encoding='utf-8',xml_declaration=True)
with osmium.SimpleWriter(sys.argv[1],overwrite=True) as writer:
    processor = osmium.FileProcessor(temporary)
    for obj in processor: writer.add(obj)
temporary.unlink()
