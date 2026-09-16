# A disposable PostgreSQL for the @jarenjs/db portability suite: PostGIS on
# top of the official PostgreSQL image, plus pgvector from the same PGDG apt
# repository the base image already configures. Both extensions are created
# by `init/10-extensions.sql` in the template database, so every disposable
# schema the test suite makes inherits them.
#
# Nothing here is a runtime dependency of any published package. The store
# reaches PostgreSQL through an injected, standards-shaped client; this image
# exists so the live half of the portability corpus has an endpoint to run
# against.
ARG POSTGIS_IMAGE=postgis/postgis@sha256:01a6a70e41e6c4467c8f55f6063555ed72db2d6662cd0d571040d42eadaeb6f6
FROM ${POSTGIS_IMAGE}
ARG PGVECTOR_PACKAGE_VERSION=0.8.6-1.pgdg11+1

# PG_MAJOR comes from the base image, so the extension matches the server
# that will load it rather than a version guessed here.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-pgvector=${PGVECTOR_PACKAGE_VERSION}"; \
    rm -rf /var/lib/apt/lists/*

COPY init/ /docker-entrypoint-initdb.d/
