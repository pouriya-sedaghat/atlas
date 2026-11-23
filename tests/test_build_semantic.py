"""Producer domains and equality distinguish semantic values from encoding."""
import copy
from unittest import TestCase
from django.core.exceptions import ValidationError

BLOCK={'schema_version':1,'block':2,'encoding':'raw','raw_size':100,'granularity':'7',
       'date_granularity':'13','lat_offset':'-51','lon_offset':'83','missing':[]}
NODE={'schema_version':1,'type':'node','id':'9223372036854775807','ordinal':1,'block':2,
      'tags':[['name','v\0é'],['name',''],['k\0','v\0']],
      'metadata':{'present':True,'missing':['visible'],'version':'1','timestamp_ticks':'100',
                  'timestamp_ms':'1300','changeset':'0','uid':'0','user_sid':'4','user':'u\0'},
      'encoded_lat':'123','encoded_lon':'-456','lat_nanodegrees':'810','lon_nanodegrees':'-3109'}

class BuildSemanticTests(TestCase):
    def test_encoding_variation_preserves_semantics_and_all_original_values(self):
        from atlas_build.semantic import validate_record,semantic_bytes,validate_block
        validate_block(BLOCK);validate_record(NODE,BLOCK)
        altered=copy.deepcopy(NODE);other=copy.deepcopy(BLOCK)
        other.update(block=7,encoding='zlib',granularity='14',lat_offset='-44',date_granularity='26')
        altered.update(ordinal=7,block=7,encoded_lat='61',encoded_lon='-228')
        altered['metadata'].update(timestamp_ticks='50',user_sid='9')
        validate_block(other);validate_record(altered,other)
        self.assertEqual(semantic_bytes(NODE),semantic_bytes(altered))
        self.assertNotEqual(NODE,altered)

    def test_presence_tag_order_locations_and_coordinates_remain_significant(self):
        from atlas_build.semantic import semantic_bytes
        for mutate in [lambda x:x['tags'].reverse(),lambda x:x.update(lat_nanodegrees='811'),
                       lambda x:x['metadata'].update(present=False),lambda x:x['metadata'].update(user='')]:
            other=copy.deepcopy(NODE);mutate(other)
            self.assertNotEqual(semantic_bytes(NODE),semantic_bytes(other))
        base={'schema_version':1,'type':'way','id':'1','ordinal':1,'block':2,'tags':[],
              'metadata':{'present':False,'missing':['version','timestamp','changeset','uid','user_sid','visible']},
              'refs':[],'locations':None}
        other=copy.deepcopy(base);other['locations']=[]
        self.assertNotEqual(semantic_bytes(base),semantic_bytes(other))

    def test_full_equality_is_required_even_with_a_forced_digest_collision(self):
        from atlas_build.semantic import identical
        changed=copy.deepcopy(NODE);changed['tags'][0][1]='different'
        class Collision:
            def digest(self):return b'x'*32
        self.assertFalse(identical(NODE,changed,hash_fn=lambda b:Collision()))
        self.assertTrue(identical(NODE,copy.deepcopy(NODE),hash_fn=lambda b:Collision()))

    def test_producer_integer_domains_and_presence_are_checked_before_copy(self):
        from atlas_build.semantic import validate_record
        for key,value in [('id','9223372036854775808'),('encoded_lat','9223372036854775808'),
                          ('lat_nanodegrees','810.0')]:
            other=copy.deepcopy(NODE);other[key]=value
            with self.assertRaises(ValidationError):validate_record(other,BLOCK)
        for change in [{'timestamp_ms':'1301'},{'uid':'2147483648'},{'user_sid':'4294967296'},
                       {'missing':['uid','visible']},{'present':False},{'visible':False}]:
            other=copy.deepcopy(NODE);other['metadata'].update(change)
            with self.assertRaises(ValidationError):validate_record(other,BLOCK)

    def test_block_numbers_may_have_gaps_and_indexdata_empty_is_present(self):
        from atlas_build.semantic import validate_block
        block=copy.deepcopy(BLOCK);block.update(block=7,indexdata_hex='')
        validate_block(block)
        for change in [{'granularity':'0'},{'lat_offset':'9223372036854775808'},
                       {'indexdata_hex':'gg'},{'missing':['granularity']}]:
            other={**block,**change}
            with self.assertRaises(ValidationError):validate_block(other)

    def test_actual_accepted_zlib_data_spelling_is_preserved_without_rewriting_ir(self):
        from atlas_build.semantic import validate_block
        block={**BLOCK,'encoding':'zlib_data'};original=copy.deepcopy(block)
        validate_block(block);self.assertEqual(block,original)
        with self.assertRaises(ValidationError):validate_block({**block,'encoding':'other'})
