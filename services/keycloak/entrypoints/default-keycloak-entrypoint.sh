#!/bin/sh
KEYCLOAK_USER=$KEYCLOAK_ADMIN_USER KEYCLOAK_PASSWORD=$KEYCLOAK_ADMIN_PASSWORD /opt/jboss/tools/docker-entrypoint.sh "$@"
