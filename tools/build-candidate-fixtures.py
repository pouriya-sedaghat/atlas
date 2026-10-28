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
for name in ['candidate-healthy','candidate-geometry','candidate-details','candidate-topology']:
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
    if name=='candidate-details':
        def tag(obj,key,value):ET.SubElement(obj,'tag',k=key,v=value)
        point=doc.find("node[@id='3']");tag(point,'power','transformer');tag(point,'barrier','gate')
        road=doc.find("way[@id='10']");tag(road,'power','line')
        for id,key,value in [('4','natural','peak'),('5','man_made','mast'),('6','highway','traffic_signals'),('7','entrance','main'),('8','addr:housenumber','۱۲'),('9','power','https://example.org/not-a-power-type')]:
            n=ET.SubElement(doc,'node',id=id,lon='0.015',lat=str(.015+int(id)*.0001),version='1');tag(n,key,value)
        for id,key,value,closed,extra in [('11','barrier','fence',True,{}),('12','power','substation',True,{'building':'yes'}),('13','aeroway','runway',False,{}),('14','aeroway','apron',True,{}),('15','aerialway','cable_car',False,{}),('16','highway','pedestrian',True,{'area':'yes'}),('17','natural','cliff',True,{})]:
            w=ET.SubElement(doc,'way',id=id,version='1')
            for ref in (['1','2','3','1'] if closed else ['1','2']):ET.SubElement(w,'nd',ref=ref)
            tag(w,key,value)
            for k,v in extra.items():tag(w,k,v)
    if name=='candidate-topology':
        def relation(id,members):
            r=ET.SubElement(doc,'relation',id=str(id),version='1')
            for type,ref,role in members:ET.SubElement(r,'member',type=type,ref=str(ref),role=role)
            for key,value in [('type','boundary'),('boundary','administrative'),('admin_level','4')]:ET.SubElement(r,'tag',k=key,v=value)
        relation(31,[('way',10,'outer'),('way',999,'outer')])
        relation(32,[('way',10,'outer'),('relation',31,'subarea')])
        relation(33,[('way',10,'outer'),('relation',34,'outer')])
        relation(34,[('way',10,'outer')])
        relation(35,[('way',10,'outer'),('relation',34,'label')])
    order={'node':0,'way':1,'relation':2};doc[:]=sorted(doc,key=lambda e:(order[e.tag],int(e.attrib['id'])))
    xml=folder/(name+'.osm');ET.ElementTree(doc).write(xml,encoding='utf-8',xml_declaration=True)
    with osmium.SimpleWriter(folder/(name+'.osm.pbf'),overwrite=True) as writer:
        for obj in osmium.FileProcessor(xml):writer.add(obj)
    xml.unlink()
