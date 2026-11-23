CREATE SCHEMA raw;
CREATE SCHEMA spatial;
CREATE SCHEMA atlas_meta;
CREATE TABLE atlas_meta.identity (singleton boolean PRIMARY KEY CHECK(singleton), marker jsonb NOT NULL, state text NOT NULL, fingerprint bytea);
CREATE TABLE raw.source (source_id uuid PRIMARY KEY,run_id uuid NOT NULL,verification_id uuid NOT NULL,
 region_id text NOT NULL,coverage_role text NOT NULL CHECK(coverage_role IN('pbf','boundary_only')),
 batch_sha256 bytea NOT NULL CHECK(octet_length(batch_sha256)=32),region_manifest bytea NOT NULL,
 region_manifest_sha256 bytea NOT NULL CHECK(octet_length(region_manifest_sha256)=32),provenance bytea NOT NULL,
 UNIQUE(verification_id,region_id));
CREATE TABLE raw.block (source_id uuid REFERENCES raw.source,block_no bigint CHECK(block_no>=2),
 encoding text NOT NULL CHECK(encoding IN('raw','zlib','zlib_data')),raw_size integer NOT NULL CHECK(raw_size>=0 AND raw_size<33554432),
 granularity integer NOT NULL CHECK(granularity>0),date_granularity integer NOT NULL CHECK(date_granularity>0),
 lat_offset bigint NOT NULL,lon_offset bigint NOT NULL,missing_fields text[] NOT NULL,index_data bytea,
 record_line bytea NOT NULL CHECK(octet_length(record_line)<33554432),record_sha256 bytea NOT NULL CHECK(octet_length(record_sha256)=32),
 PRIMARY KEY(source_id,block_no));
CREATE TABLE raw.object_record(source_id uuid NOT NULL,ordinal bigint CHECK(ordinal>0),
 kind smallint NOT NULL CHECK(kind BETWEEN 0 AND 2),osm_id bigint NOT NULL CHECK(osm_id>0),block_no bigint NOT NULL,
 record_line bytea NOT NULL CHECK(octet_length(record_line)>0 AND octet_length(record_line)<33554432),
 record_sha256 bytea NOT NULL CHECK(octet_length(record_sha256)=32),semantic_sha256 bytea NOT NULL CHECK(octet_length(semantic_sha256)=32),
 PRIMARY KEY(source_id,ordinal),UNIQUE(source_id,kind,osm_id),FOREIGN KEY(source_id,block_no) REFERENCES raw.block);
CREATE INDEX object_typed_source ON raw.object_record(kind,osm_id,source_id);
CREATE TABLE raw.osm_object(kind smallint CHECK(kind BETWEEN 0 AND 2),osm_id bigint CHECK(osm_id>0),
 semantic_sha256 bytea NOT NULL CHECK(octet_length(semantic_sha256)=32),representative_source uuid NOT NULL,
 PRIMARY KEY(kind,osm_id),FOREIGN KEY(representative_source,kind,osm_id) REFERENCES raw.object_record(source_id,kind,osm_id));
CREATE TABLE raw.info(source_id uuid,ordinal bigint,info_present boolean NOT NULL,missing_fields text[] NOT NULL,
 version integer,timestamp_ticks bigint,timestamp_ms numeric,changeset bigint,uid integer,user_sid bigint,user_utf8 bytea,
 PRIMARY KEY(source_id,ordinal),FOREIGN KEY(source_id,ordinal) REFERENCES raw.object_record,
 CHECK(version IS NULL OR version>0),CHECK(changeset IS NULL OR changeset>=0),CHECK(uid IS NULL OR uid>=0),
 CHECK(user_sid IS NULL OR user_sid BETWEEN 0 AND 4294967295),CHECK((timestamp_ticks IS NULL)=(timestamp_ms IS NULL)),
 CHECK((user_sid IS NULL)=(user_utf8 IS NULL)));
CREATE TABLE raw.node_value(source_id uuid,ordinal bigint,encoded_lat bigint NOT NULL,encoded_lon bigint NOT NULL,
 lat_nd bigint NOT NULL CHECK(lat_nd BETWEEN -90000000000 AND 90000000000),
 lon_nd bigint NOT NULL CHECK(lon_nd BETWEEN -180000000000 AND 180000000000),
 PRIMARY KEY(source_id,ordinal),FOREIGN KEY(source_id,ordinal) REFERENCES raw.object_record);
CREATE TABLE raw.tag(source_id uuid,ordinal bigint,position integer CHECK(position>0),key_utf8 bytea NOT NULL,value_utf8 bytea NOT NULL,
 PRIMARY KEY(source_id,ordinal,position),FOREIGN KEY(source_id,ordinal) REFERENCES raw.object_record);
CREATE TABLE raw.way_state(source_id uuid,ordinal bigint,locations_present boolean NOT NULL,
 PRIMARY KEY(source_id,ordinal),FOREIGN KEY(source_id,ordinal) REFERENCES raw.object_record);
CREATE TABLE raw.way_ref(source_id uuid,ordinal bigint,position integer CHECK(position>0),node_id bigint NOT NULL CHECK(node_id>0),
 lat_nd bigint CHECK(lat_nd BETWEEN -90000000000 AND 90000000000),lon_nd bigint CHECK(lon_nd BETWEEN -180000000000 AND 180000000000),
 PRIMARY KEY(source_id,ordinal,position),FOREIGN KEY(source_id,ordinal) REFERENCES raw.way_state,CHECK((lat_nd IS NULL)=(lon_nd IS NULL)));
CREATE TABLE raw.member(source_id uuid,ordinal bigint,position integer CHECK(position>0),target_kind smallint NOT NULL CHECK(target_kind BETWEEN 0 AND 2),
 target_id bigint NOT NULL CHECK(target_id>0),role_utf8 bytea NOT NULL,
 PRIMARY KEY(source_id,ordinal,position),FOREIGN KEY(source_id,ordinal) REFERENCES raw.object_record);
CREATE INDEX member_target_idx ON raw.member(source_id,target_kind,target_id);
CREATE TABLE raw.poly_source(source_id uuid PRIMARY KEY REFERENCES raw.source,sidecar_bytes bytea NOT NULL CHECK(octet_length(sidecar_bytes)<=16777216),
 sidecar_sha256 bytea NOT NULL CHECK(octet_length(sidecar_sha256)=32),input_descriptor bytea NOT NULL,verified_wkb bytea NOT NULL);
CREATE TABLE spatial.node_point(kind smallint DEFAULT 0 CHECK(kind=0),osm_id bigint,geom geometry(Point,4326) NOT NULL,
 PRIMARY KEY(kind,osm_id),FOREIGN KEY(kind,osm_id) REFERENCES raw.osm_object);
CREATE TABLE spatial.boundary(source_id uuid PRIMARY KEY REFERENCES raw.source,geom geometry(MultiPolygon,4326) NOT NULL);
CREATE INDEX node_point_gix ON spatial.node_point USING gist(geom);
CREATE INDEX boundary_gix ON spatial.boundary USING gist(geom);
