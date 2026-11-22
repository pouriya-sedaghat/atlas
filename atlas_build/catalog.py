"""Logical Atlas DDL identity, independent of heap files and query statistics."""
import hashlib
from psycopg.rows import dict_row
from atlas_verification.control import canonical

SCHEMAS=['raw','spatial','atlas_meta']
TABLES={'raw.source','raw.block','raw.object_record','raw.osm_object','raw.info','raw.node_value','raw.tag',
        'raw.way_state','raw.way_ref','raw.member','raw.poly_source','spatial.node_point','spatial.boundary','atlas_meta.identity'}


def snapshot(conn):
    def rows(query):
        with conn.cursor(row_factory=dict_row) as cursor:return cursor.execute(query,[SCHEMAS]).fetchall()
    return {
      'namespaces':rows('SELECT nspname,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=ANY(%s) ORDER BY nspname'),
      'relations':rows('''SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,
         c.relpersistence,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=ANY(%s) ORDER BY n.nspname,c.relname'''),
      'columns':rows('''SELECT n.nspname,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
         a.attnotnull,a.attidentity,a.attgenerated,a.attstorage,a.attcompression,pg_get_expr(d.adbin,d.adrelid) AS default_value
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
         LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
         WHERE n.nspname=ANY(%s) AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum'''),
      'constraints':rows('''SELECT n.nspname,r.relname,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,
         pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
         JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=ANY(%s)
         AND NOT(n.nspname='raw' AND r.relname='object_record' AND c.conname='occurrence_canonical_fk')
         ORDER BY n.nspname,r.relname,c.conname'''),
      'indexes':rows('SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=ANY(%s) ORDER BY schemaname,tablename,indexname'),
      'routines':rows('''SELECT n.nspname,p.proname,p.prokind,p.prosecdef,pg_get_function_identity_arguments(p.oid) AS arguments
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY(%s) ORDER BY n.nspname,p.proname,p.oid'''),
    }


def fingerprint(value):return hashlib.sha256(canonical(value)).hexdigest()
