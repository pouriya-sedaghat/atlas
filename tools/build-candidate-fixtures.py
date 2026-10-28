"""Fictional valid OSM topology with deliberately unrenderable catalog geometry."""
from pathlib import Path
import sys,xml.etree.ElementTree as ET
import osmium

folder=Path(sys.argv[1]);folder.mkdir(parents=True,exist_ok=True)
healthy='''<osm version="0.6" generator="atlas-candidate-fictional">
<node id="1" lon="0" lat="0" version="1"/>
<node id="2" lon="0" lat="0.01" version="1"/>
<node id="3" lon="0.01" lat="0.02" version="1"><tag k="amenity" v="hospital"/><tag k="name:fa" v="بیمارستان آزمایشی"/></node>
<way id="10" version="1"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
</osm>'''
for name in ['candidate-healthy','candidate-geometry']:
    doc=ET.fromstring(healthy)
    if name=='candidate-geometry':
        # A successful line plus a failed polygon on one object must be reported as partial.
        w=ET.SubElement(doc,'way',id='20',version='1')
        for ref in ['1','2','1']:ET.SubElement(w,'nd',ref=ref)
        ET.SubElement(w,'tag',k='highway',v='service');ET.SubElement(w,'tag',k='building',v='yes')
        w=ET.SubElement(doc,'way',id='21',version='1')
        for ref in ['1','1']:ET.SubElement(w,'nd',ref=ref)
        ET.SubElement(w,'tag',k='highway',v='service')
        r=ET.SubElement(doc,'relation',id='30',version='1');ET.SubElement(r,'tag',k='type',v='multipolygon');ET.SubElement(r,'tag',k='building',v='yes')
        n=ET.SubElement(doc,'node',id='4',lon='0.015',lat='0.015',version='1');ET.SubElement(n,'tag',k='unknown:feature',v='preserved, not silently rendered')
        n=ET.SubElement(doc,'node',id='5',lon='0.016',lat='0.016',version='1');ET.SubElement(n,'tag',k='layer',v='1')
        n=ET.SubElement(doc,'node',id='6',lon='0.017',lat='0.017',version='1');ET.SubElement(n,'tag',k='source',v='fictional metadata only')
    order={'node':0,'way':1,'relation':2};doc[:]=sorted(doc,key=lambda e:(order[e.tag],int(e.attrib['id'])))
    xml=folder/(name+'.osm');ET.ElementTree(doc).write(xml,encoding='utf-8',xml_declaration=True)
    with osmium.SimpleWriter(folder/(name+'.osm.pbf'),overwrite=True) as writer:
        for obj in osmium.FileProcessor(xml):writer.add(obj)
    xml.unlink()
