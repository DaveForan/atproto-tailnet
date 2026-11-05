#!/usr/bin/env bash
# Removes every fedspike- container and network. Touches nothing else.
set -u
ids=$(docker ps -aq --filter 'name=^/fedspike-')
[ -n "$ids" ] && docker rm -f $ids >/dev/null
for n in $(docker network ls --format '{{.Name}}' | grep '^fedspike-'); do
  docker network rm "$n" >/dev/null
done
echo "remaining fedspike containers: $(docker ps -a --filter 'name=^/fedspike-' --format '{{.Names}}' | tr '\n' ' ')"
echo "remaining fedspike networks:   $(docker network ls --format '{{.Name}}' | grep '^fedspike-' | tr '\n' ' ')"
