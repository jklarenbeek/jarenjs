//@ts-check
/** Source-preserving PostgreSQL catalog inventory. OIDs join catalog rows but
 * never become portable object identities or serialized migration checksums. */
import { postgresDependencies } from './postgres-dependencies.js';

/** Every object is scoped by its namespace; source programs stay native SQL.
 * @param {string} namespace - trusted SQL predicate over n.nspname
 * @returns {string} */
export function postgresCatalog(namespace) {
  return `WITH relations AS (
    SELECT c.*, n.nspname AS schema FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${namespace}
  ), ${postgresDependencies(namespace)}, objects AS (
    SELECT 'schema' AS type,n.nspname::text AS name,n.nspname::text AS owner,n.nspname::text AS schema,NULL::text AS sql,
      pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(n.nspowner),'acl',n.nspacl::text,
        'encoding',pg_catalog.pg_encoding_to_char(d.encoding),'collation',d.datcollate,'ctype',d.datctype,
        'localeProvider',d.datlocprovider,'collationVersion',d.datcollversion) AS metadata
    FROM pg_catalog.pg_namespace n CROSS JOIN pg_catalog.pg_database d
    WHERE ${namespace} AND d.datname=current_database()
    UNION ALL
    SELECT 'dependency',pg_catalog.jsonb_build_array(dependent,referenced,deptype)::text,owner,schema,external_sql,
      pg_catalog.jsonb_build_object('dependent',dependent,'referenced',referenced,'kind',deptype,
        'referencedSql',referenced_sql,'extension',extension_name,'extensionVersion',extension_version,'extensionSchema',extension_schema)
    FROM edges
    UNION ALL
    SELECT CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS type,
      c.relname AS name, c.relname AS owner, c.schema,
      CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid, true) ELSE NULL END AS sql,
      pg_catalog.jsonb_build_object('kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),
        'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'persistence',c.relpersistence,
        'partition',pg_catalog.pg_get_expr(c.relpartbound,c.oid),'partitionKey',pg_catalog.pg_get_partkeydef(c.oid),'options',c.reloptions,
        'inherits',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('schema',pn.nspname,'name',pc.relname) ORDER BY h.inhseqno)
          FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class pc ON pc.oid=h.inhparent
          JOIN pg_catalog.pg_namespace pn ON pn.oid=pc.relnamespace WHERE h.inhrelid=c.oid),
        'acl',c.relacl::text,'replicaIdentity',c.relreplident,'accessMethod',am.amname) AS metadata
    FROM relations c LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    WHERE c.relkind IN ('r','p','v','m','f')
    UNION ALL
    SELECT 'column', a.attname, c.relname, c.schema, pg_catalog.pg_get_expr(d.adbin,d.adrelid),
      pg_catalog.jsonb_build_object('ordinal',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'typeSchema',tn.nspname,'typeName',t.typname,'typeKind',t.typtype,
        'nullable',NOT a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
        'collationSchema',cn.nspname,'collation',co.collname,'collationDeterministic',co.collisdeterministic,
        'storage',a.attstorage,'compression',a.attcompression,'acl',a.attacl::text)
    FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint', k.conname, c.relname, c.schema, pg_catalog.pg_get_constraintdef(k.oid,true),
      pg_catalog.jsonb_build_object('kind',k.contype,'deferrable',k.condeferrable,
        'initiallyDeferred',k.condeferred,'validated',k.convalidated,'noInherit',k.connoinherit,
        'columns',(SELECT pg_catalog.jsonb_agg(a.attname ORDER BY part.ord)
          FROM unnest(k.conkey) WITH ORDINALITY part(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=part.num),
        'targetSchema',tn.nspname,'targetTable',tc.relname,
        'targetColumns',(SELECT pg_catalog.jsonb_agg(a.attname ORDER BY part.ord)
          FROM unnest(k.confkey) WITH ORDINALITY part(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=part.num))
    FROM relations c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid
    LEFT JOIN pg_catalog.pg_class tc ON tc.oid=k.confrelid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
    UNION ALL
    SELECT 'index', ci.relname, c.relname, c.schema, pg_catalog.pg_get_indexdef(i.indexrelid),
      pg_catalog.jsonb_build_object('method',am.amname,'unique',i.indisunique,'primary',i.indisprimary,
        'exclusion',i.indisexclusion,'valid',i.indisvalid,'ready',i.indisready,
        'nullsNotDistinct',i.indnullsnotdistinct,'keyCount',i.indnkeyatts,'options',ci.reloptions,
        'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid),
        'expressions',pg_catalog.pg_get_expr(i.indexprs,i.indrelid),
        'opclasses',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'schema',ns.nspname,'name',op.opcname,'default',op.opcdefault) ORDER BY part.ord)
          FROM unnest(i.indclass::oid[]) WITH ORDINALITY part(id,ord)
          JOIN pg_catalog.pg_opclass op ON op.oid=part.id JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace))
    FROM relations c JOIN pg_catalog.pg_index i ON i.indrelid=c.oid
    JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ci.relam
    UNION ALL
    SELECT 'trigger', t.tgname, c.relname, c.schema, pg_catalog.pg_get_triggerdef(t.oid,true),
      pg_catalog.jsonb_build_object('enabled',t.tgenabled,'deferrable',t.tgdeferrable,
        'initiallyDeferred',t.tginitdeferred,'functionSchema',pn.nspname,'function',p.proname,
        'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid))
    FROM relations c JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE NOT t.tgisinternal
    UNION ALL
    SELECT 'policy', p.polname, c.relname, c.schema, NULL,
      pg_catalog.jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT pg_catalog.jsonb_agg(CASE WHEN role=0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(role) END ORDER BY role)
          FROM unnest(p.polroles) role),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),
        'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
    FROM relations c JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
    UNION ALL
    SELECT 'sequence', c.relname, COALESCE(tc.relname,c.relname), c.schema, NULL,
      pg_catalog.jsonb_build_object('type',pg_catalog.format_type(s.seqtypid,NULL),
        'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,
        'cache',s.seqcache::text,'cycle',s.seqcycle,'owner',pg_catalog.pg_get_userbyid(c.relowner),
        'tableSchema',tn.nspname,'table',tc.relname,'column',a.attname,'dependency',d.deptype,'acl',c.relacl::text)
    FROM relations c JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid
    LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid
      AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN ('a','i')
    LEFT JOIN pg_catalog.pg_class tc ON tc.oid=d.refobjid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    UNION ALL
    SELECT 'function', p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
      p.proname, n.nspname, CASE WHEN p.prokind IN ('f','p') THEN pg_catalog.pg_get_functiondef(p.oid) ELSE NULL END,
      pg_catalog.jsonb_build_object('kind',p.prokind,'language',l.lanname,
        'owner',pg_catalog.pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,
        'volatility',p.provolatile,'parallel',p.proparallel,'config',p.proconfig,'acl',p.proacl::text,
        'extension',(SELECT e.extname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
          WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'))
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE ${namespace}
    UNION ALL
    SELECT 'type', t.typname, t.typname, n.nspname, NULL,
      pg_catalog.jsonb_build_object('kind',t.typtype,'owner',pg_catalog.pg_get_userbyid(t.typowner),
        'base',pg_catalog.format_type(t.typbasetype,t.typtypmod),'notNull',t.typnotnull,'default',t.typdefault,
        'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',k.conname,
          'sql',pg_catalog.pg_get_constraintdef(k.oid,true),'validated',k.convalidated) ORDER BY k.conname)
          FROM pg_catalog.pg_constraint k WHERE k.contypid=t.oid),
        'attributes',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,
          'type',pg_catalog.format_type(a.atttypid,a.atttypmod)) ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped),
        'range',(SELECT pg_catalog.jsonb_build_object('subtype',pg_catalog.format_type(r.rngsubtype,NULL),
          'multirange',pg_catalog.format_type(r.rngmultitypid,NULL),'collation',r.rngcollation::regcollation::text,
          'canonical',r.rngcanonical::regprocedure::text,'difference',r.rngsubdiff::regprocedure::text,
          'opclassSchema',ons.nspname,'opclass',op.opcname)
          FROM pg_catalog.pg_range r JOIN pg_catalog.pg_opclass op ON op.oid=r.rngsubopc
          JOIN pg_catalog.pg_namespace ons ON ons.oid=op.opcnamespace WHERE r.rngtypid=t.oid OR r.rngmultitypid=t.oid),
        'enum',(SELECT pg_catalog.jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid),
        'extension',(SELECT e.extname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
          WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.deptype='e'))
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE ${namespace} AND (t.typrelid=0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t.typrelid AND c.relkind='c')) AND t.typelem=0
  ) SELECT type,name,owner,schema,sql,metadata::text AS metadata FROM objects ORDER BY schema,type,owner,name`;
}
