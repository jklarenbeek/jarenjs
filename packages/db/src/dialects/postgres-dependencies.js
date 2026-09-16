//@ts-check
/** Native dependency edges rooted in the owned namespace. Dynamic SQL bodies
 * are deliberately opaque: only PostgreSQL's recorded dependencies appear. */

/** CTEs consumed by the complete catalog query; identifiers never persist OIDs.
 * @param {string} namespace @returns {string} */
export function postgresDependencies(namespace) {
  return `roots AS (
    SELECT 'pg_catalog.pg_class'::regclass AS classid,c.oid AS objid,c.schema,
      COALESCE(parent.relname,c.relname) AS owner
    FROM relations c LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
    LEFT JOIN pg_catalog.pg_class parent ON parent.oid=i.indrelid
    UNION ALL
    SELECT 'pg_catalog.pg_attrdef'::regclass,d.oid,c.schema,c.relname FROM relations c JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid
    UNION ALL
    SELECT 'pg_catalog.pg_constraint'::regclass,d.oid,c.schema,c.relname FROM relations c JOIN pg_catalog.pg_constraint d ON d.conrelid=c.oid
    UNION ALL
    SELECT 'pg_catalog.pg_trigger'::regclass,d.oid,c.schema,c.relname FROM relations c JOIN pg_catalog.pg_trigger d ON d.tgrelid=c.oid
    UNION ALL
    SELECT 'pg_catalog.pg_policy'::regclass,d.oid,c.schema,c.relname FROM relations c JOIN pg_catalog.pg_policy d ON d.polrelid=c.oid
    UNION ALL
    SELECT 'pg_catalog.pg_rewrite'::regclass,d.oid,c.schema,c.relname FROM relations c JOIN pg_catalog.pg_rewrite d ON d.ev_class=c.oid
    UNION ALL
    SELECT 'pg_catalog.pg_proc'::regclass,p.oid,n.nspname,p.proname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE ${namespace}
    UNION ALL
    SELECT 'pg_catalog.pg_type'::regclass,t.oid,n.nspname,COALESCE(c.relname,t.typname)
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_class c ON c.oid=t.typrelid WHERE ${namespace}
  ), edges AS (
    SELECT DISTINCT COALESCE(source.schema,target.schema) AS schema,COALESCE(source.owner,target.owner) AS owner,
      pg_catalog.to_jsonb(a) || pg_catalog.jsonb_build_object('schema',COALESCE(a.schema,rn.nspname)) AS dependent,
      pg_catalog.to_jsonb(b) AS referenced,d.deptype,
      CASE WHEN COALESCE(a.schema,rn.nspname) IS DISTINCT FROM COALESCE(source.schema,target.schema) THEN
        CASE WHEN d.classid='pg_catalog.pg_rewrite'::regclass THEN pg_catalog.pg_get_viewdef(r.ev_class,true)
          WHEN d.classid='pg_catalog.pg_proc'::regclass AND p.prokind IN ('f','p') THEN pg_catalog.pg_get_functiondef(p.oid) END END AS external_sql,
      CASE WHEN b.schema IS DISTINCT FROM COALESCE(source.schema,target.schema)
        AND rp.prokind IN ('f','p') THEN pg_catalog.pg_get_functiondef(rp.oid) END AS referenced_sql,
      e.extname AS extension_name,e.extversion AS extension_version,en.nspname AS extension_schema
    FROM pg_catalog.pg_depend d
    LEFT JOIN roots source ON source.classid=d.classid AND source.objid=d.objid
    LEFT JOIN roots target ON target.classid=d.refclassid AND target.objid=d.refobjid
    CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.classid,d.objid,d.objsubid) a
    CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) b
    LEFT JOIN pg_catalog.pg_rewrite r ON d.classid='pg_catalog.pg_rewrite'::regclass AND r.oid=d.objid
    LEFT JOIN pg_catalog.pg_class rc ON rc.oid=r.ev_class
    LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace
    LEFT JOIN pg_catalog.pg_proc p ON d.classid='pg_catalog.pg_proc'::regclass AND p.oid=d.objid
    LEFT JOIN pg_catalog.pg_proc rp ON d.refclassid='pg_catalog.pg_proc'::regclass AND rp.oid=d.refobjid
    LEFT JOIN pg_catalog.pg_depend membership ON membership.classid=d.refclassid AND membership.objid=d.refobjid
      AND membership.refclassid='pg_catalog.pg_extension'::regclass AND membership.deptype='e'
    LEFT JOIN pg_catalog.pg_extension e ON e.oid=COALESCE(membership.refobjid,
      CASE WHEN d.refclassid='pg_catalog.pg_extension'::regclass THEN d.refobjid END)
    LEFT JOIN pg_catalog.pg_namespace en ON en.oid=e.extnamespace
    WHERE (source.objid IS NOT NULL OR target.objid IS NOT NULL) AND d.deptype IN ('n','e')
      AND a.schema IS DISTINCT FROM 'pg_catalog' AND a.schema IS DISTINCT FROM 'information_schema'
      AND b.schema IS DISTINCT FROM 'pg_catalog' AND b.schema IS DISTINCT FROM 'information_schema'
      AND d.refclassid<>'pg_catalog.pg_namespace'::regclass
  )`;
}
