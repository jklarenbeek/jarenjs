#!/bin/bash
# Load pgvector beside the PostGIS the base image's own init script already
# created (its number puts it first). Both the created database and the
# PostGIS template get it, so a disposable database made from either carries
# the extension without the suite ever issuing CREATE EXTENSION itself — an
# order that needed one at run time would be declaring a vendor feature the
# model cannot express.
set -e
export PGUSER="$POSTGRES_USER"

for DB in template1 template_postgis "$POSTGRES_DB"; do
	echo "Loading pgvector into $DB"
	"${psql[@]}" --dbname="$DB" <<-'EOSQL'
		CREATE EXTENSION IF NOT EXISTS vector;
	EOSQL
done
